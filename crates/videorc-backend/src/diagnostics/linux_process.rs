//! Linux resource sampling is restricted to the backend and its descendants.
//! A host-wide `ps` scan can block on an unrelated process's kernel state.

use std::collections::{HashSet, VecDeque};
use std::path::Path;

use super::ProcessSampleRow;

pub(super) fn collect(backend_pid: u32, proc_root: &Path) -> Option<Vec<ProcessSampleRow>> {
    let root = read_row(proc_root, backend_pid)?;
    let mut rows = vec![root];
    let mut visited = HashSet::from([backend_pid]);
    let mut parents = VecDeque::from([backend_pid]);
    while let Some(parent) = parents.pop_front() {
        // Linux records children on the thread that spawned them. Looking at
        // only task/<pid>/children misses FFmpeg spawned by a worker thread.
        let Ok(tasks) = std::fs::read_dir(proc_root.join(parent.to_string()).join("task")) else {
            continue;
        };
        for task in tasks.flatten() {
            if task.file_name().to_string_lossy().parse::<u32>().is_err() {
                continue;
            }
            let Ok(children) = std::fs::read_to_string(task.path().join("children")) else {
                continue;
            };
            for child in children
                .split_whitespace()
                .filter_map(|pid| pid.parse().ok())
            {
                if !visited.insert(child) {
                    continue;
                }
                let Some(row) = read_row(proc_root, child) else {
                    continue;
                };
                // The child may have exited, been reparented, or had its PID
                // reused between the children list and this status read.
                if row.parent_pid != parent {
                    continue;
                }
                rows.push(row);
                parents.push_back(child);
            }
        }
    }
    Some(rows)
}

fn read_row(proc_root: &Path, pid: u32) -> Option<ProcessSampleRow> {
    let status = std::fs::read_to_string(proc_root.join(pid.to_string()).join("status")).ok()?;
    parse_status(&status, pid)
}

fn parse_status(status: &str, expected_pid: u32) -> Option<ProcessSampleRow> {
    let field = |name: &str| status.lines().find_map(|line| line.strip_prefix(name));
    let pid = field("Pid:")?.trim().parse().ok()?;
    if pid != expected_pid {
        return None;
    }
    let parent_pid = field("PPid:")?.trim().parse().ok()?;
    let command = field("Name:")?.trim().to_owned();
    let mut rss = field("VmRSS:")?.split_whitespace();
    let rss_kib = rss.next()?.parse().ok()?;
    // procfs reports kB in units of 1024 bytes. Missing RSS (e.g. a zombie)
    // or malformed units are unavailable evidence, never a zero-sized process.
    if command.is_empty() || rss.next()? != "kB" || rss.next().is_some() {
        return None;
    }
    Some(ProcessSampleRow {
        pid,
        parent_pid,
        rss_kib,
        command,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    struct ProcFixture(std::path::PathBuf);
    impl ProcFixture {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("videorc-proc-sampler-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&root).unwrap();
            Self(root)
        }
        fn process(&self, pid: u32, parent: u32, name: &str, rss: u64) {
            let dir = self.0.join(pid.to_string());
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(
                dir.join("status"),
                format!("Name:\t{name}\nPid:\t{pid}\nPPid:\t{parent}\nVmRSS:\t{rss} kB\n"),
            )
            .unwrap();
        }
        fn children(&self, pid: u32, tid: u32, children: &str) {
            let dir = self
                .0
                .join(pid.to_string())
                .join("task")
                .join(tid.to_string());
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("children"), children).unwrap();
        }
    }
    impl Drop for ProcFixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn collects_worker_thread_children_and_nested_tools_without_unrelated_processes() {
        let fixture = ProcFixture::new();
        fixture.process(100, 1, "videorc-backend", 4096);
        fixture.process(101, 100, "ffmpeg", 1024);
        fixture.process(102, 101, "ffprobe", 512);
        fixture.process(200, 1, "ffmpeg", 9999);
        fixture.children(100, 100, "");
        fixture.children(100, 105, "101 101 invalid 999");
        fixture.children(101, 101, "102");
        fixture.children(102, 102, "100"); // Defensive cycle protection.
        let rows = collect(100, &fixture.0).unwrap();
        assert_eq!(rows.len(), 3);
        let snapshot = super::super::runtime_resource_snapshot_from_rows(&rows, 100);
        assert_eq!(snapshot.backend_rss_bytes, Some(4096 * 1024));
        assert_eq!(snapshot.active_ffmpeg_processes, 1);
        assert_eq!(snapshot.active_ffprobe_processes, 1);
    }

    #[test]
    fn ignores_reparented_exited_and_unreadable_children() {
        let fixture = ProcFixture::new();
        fixture.process(100, 1, "videorc-backend", 4096);
        fixture.process(101, 999, "ffmpeg", 1024);
        fixture.process(102, 100, "ffprobe", 512);
        fixture.children(100, 105, "101 102 103");
        std::fs::write(
            fixture.0.join("102/status"),
            "Name:\tffprobe\nPid:\t102\nPPid:\t100\n",
        )
        .unwrap();
        let rows = collect(100, &fixture.0).unwrap();
        assert_eq!(rows.len(), 1);
        std::fs::remove_file(fixture.0.join("100/status")).unwrap();
        assert!(collect(100, &fixture.0).is_none());
    }

    #[test]
    fn rejects_wrong_pid_and_invalid_rss_instead_of_inventing_memory() {
        let valid = "Name:\tffmpeg\nPid:\t101\nPPid:\t100\nVmRSS:\t2048 kB\n";
        assert_eq!(parse_status(valid, 101).unwrap().rss_kib, 2048);
        assert!(parse_status(valid, 102).is_none());
        for invalid in [
            valid.replace("kB", "MB"),
            valid.replace("2048", "-1"),
            valid.replace("2048", "18446744073709551616"),
            valid.replace("ffmpeg", ""),
        ] {
            assert!(parse_status(&invalid, 101).is_none());
        }
    }

    #[test]
    fn reads_real_backend_rss_without_spawning_a_process() {
        let pid = std::process::id();
        let rows = collect(pid, Path::new("/proc")).expect("read this process's procfs status");
        let own = rows.iter().find(|row| row.pid == pid).unwrap();
        assert!(own.rss_kib > 0);
        // SAFETY: getppid has no preconditions and cannot fail.
        assert_eq!(own.parent_pid, unsafe { libc::getppid() } as u32);
    }
}
