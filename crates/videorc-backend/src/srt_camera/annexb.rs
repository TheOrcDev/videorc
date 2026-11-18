//! Annex B access units (H.264 and HEVC) for the decoder: the parameter
//! sets, whether it is a key frame, and the slices in the length-prefixed
//! form VideoToolbox reads.

use super::ts_demux::VideoCodec;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ParameterSets {
    /// HEVC only.
    pub vps: Option<Vec<u8>>,
    pub sps: Option<Vec<u8>>,
    pub pps: Option<Vec<u8>>,
}

impl ParameterSets {
    pub fn complete(&self, codec: VideoCodec) -> bool {
        let base = self.sps.is_some() && self.pps.is_some();
        match codec {
            VideoCodec::H264 => base,
            VideoCodec::Hevc => base && self.vps.is_some(),
            VideoCodec::Unsupported(_) => false,
        }
    }

    /// Keeps the newest of each set from `other`.
    pub fn update(&mut self, other: &ParameterSets) {
        if other.vps.is_some() {
            self.vps.clone_from(&other.vps);
        }
        if other.sps.is_some() {
            self.sps.clone_from(&other.sps);
        }
        if other.pps.is_some() {
            self.pps.clone_from(&other.pps);
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ParsedAccessUnit {
    pub parameter_sets: ParameterSets,
    pub keyframe: bool,
    /// The picture's NAL units, each behind a 4-byte big-endian length;
    /// parameter sets and access unit delimiters left out.
    pub length_prefixed: Vec<u8>,
}

/// The NAL units of an Annex B byte stream, start codes and trailing zero
/// bytes removed.
pub fn split_nal_units(data: &[u8]) -> Vec<&[u8]> {
    let mut starts = Vec::new();
    let mut index = 0;
    while index + 3 <= data.len() {
        if data[index] == 0 && data[index + 1] == 0 && data[index + 2] == 1 {
            starts.push(index + 3);
            index += 3;
        } else {
            index += 1;
        }
    }
    let mut units = Vec::with_capacity(starts.len());
    for (position, &start) in starts.iter().enumerate() {
        let end = starts.get(position + 1).map_or(data.len(), |next| next - 3);
        let mut unit = &data[start..end];
        while let Some((&0, rest)) = unit.split_last() {
            unit = rest;
        }
        if !unit.is_empty() {
            units.push(unit);
        }
    }
    units
}

enum NalKind {
    Vps,
    Sps,
    Pps,
    Delimiter,
    KeySlice,
    Other,
}

fn nal_kind(codec: VideoCodec, unit: &[u8]) -> NalKind {
    match codec {
        VideoCodec::H264 => match unit[0] & 0x1f {
            7 => NalKind::Sps,
            8 => NalKind::Pps,
            9 => NalKind::Delimiter,
            5 => NalKind::KeySlice,
            _ => NalKind::Other,
        },
        VideoCodec::Hevc => match (unit[0] >> 1) & 0x3f {
            32 => NalKind::Vps,
            33 => NalKind::Sps,
            34 => NalKind::Pps,
            35 => NalKind::Delimiter,
            16..=21 => NalKind::KeySlice,
            _ => NalKind::Other,
        },
        VideoCodec::Unsupported(_) => NalKind::Other,
    }
}

pub fn parse_access_unit(codec: VideoCodec, data: &[u8]) -> ParsedAccessUnit {
    let mut parsed = ParsedAccessUnit::default();
    for unit in split_nal_units(data) {
        match nal_kind(codec, unit) {
            NalKind::Vps => parsed.parameter_sets.vps = Some(unit.to_vec()),
            NalKind::Sps => parsed.parameter_sets.sps = Some(unit.to_vec()),
            NalKind::Pps => parsed.parameter_sets.pps = Some(unit.to_vec()),
            NalKind::Delimiter => {}
            kind => {
                parsed.keyframe |= matches!(kind, NalKind::KeySlice);
                let length = u32::try_from(unit.len()).unwrap_or(u32::MAX);
                parsed
                    .length_prefixed
                    .extend_from_slice(&length.to_be_bytes());
                parsed.length_prefixed.extend_from_slice(unit);
            }
        }
    }
    parsed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn annexb(units: &[&[u8]]) -> Vec<u8> {
        let mut out = Vec::new();
        for (index, unit) in units.iter().enumerate() {
            if index % 2 == 0 {
                out.extend_from_slice(&[0, 0, 0, 1]);
            } else {
                out.extend_from_slice(&[0, 0, 1]);
            }
            out.extend_from_slice(unit);
        }
        out
    }

    #[test]
    fn srt_annexb_splits_three_and_four_byte_start_codes() {
        let data = annexb(&[&[0x67, 1, 2], &[0x68, 3], &[0x65, 4, 5, 6]]);
        assert_eq!(
            split_nal_units(&data),
            vec![&[0x67, 1, 2][..], &[0x68, 3][..], &[0x65, 4, 5, 6][..]]
        );
    }

    #[test]
    fn srt_annexb_h264_finds_sps_pps_and_the_idr() {
        let data = annexb(&[&[0x09, 0xf0], &[0x67, 1], &[0x68, 2], &[0x65, 3, 3]]);
        let parsed = parse_access_unit(VideoCodec::H264, &data);
        assert_eq!(parsed.parameter_sets.sps, Some(vec![0x67, 1]));
        assert_eq!(parsed.parameter_sets.pps, Some(vec![0x68, 2]));
        assert!(parsed.parameter_sets.complete(VideoCodec::H264));
        assert!(parsed.keyframe);
        assert_eq!(parsed.length_prefixed, vec![0, 0, 0, 3, 0x65, 3, 3]);
    }

    #[test]
    fn srt_annexb_h264_non_idr_is_not_a_keyframe() {
        let parsed = parse_access_unit(VideoCodec::H264, &annexb(&[&[0x41, 9]]));
        assert!(!parsed.keyframe);
        assert!(!parsed.parameter_sets.complete(VideoCodec::H264));
    }

    #[test]
    fn srt_annexb_hevc_finds_vps_sps_pps_and_the_irap() {
        // NAL type sits in bits 1..7 of the first header byte.
        let vps = [32 << 1, 1, 0xaa];
        let sps = [33 << 1, 1, 0xbb];
        let pps = [34 << 1, 1, 0xcc];
        let aud = [35 << 1, 1, 0x50];
        let idr = [19 << 1, 1, 0xdd];
        let parsed = parse_access_unit(VideoCodec::Hevc, &annexb(&[&aud, &vps, &sps, &pps, &idr]));
        assert!(parsed.parameter_sets.complete(VideoCodec::Hevc));
        assert_eq!(parsed.parameter_sets.vps, Some(vps.to_vec()));
        assert!(parsed.keyframe);
        assert_eq!(parsed.length_prefixed, [&[0, 0, 0, 3][..], &idr].concat());
        let trail = [1 << 1, 1, 0xee];
        assert!(!parse_access_unit(VideoCodec::Hevc, &annexb(&[&trail])).keyframe);
    }

    #[test]
    fn srt_annexb_parameter_sets_keep_the_newest() {
        let mut kept = ParameterSets {
            vps: Some(vec![1]),
            sps: Some(vec![2]),
            pps: None,
        };
        kept.update(&ParameterSets {
            vps: None,
            sps: Some(vec![3]),
            pps: Some(vec![4]),
        });
        assert_eq!(
            kept,
            ParameterSets {
                vps: Some(vec![1]),
                sps: Some(vec![3]),
                pps: Some(vec![4])
            }
        );
    }
}
