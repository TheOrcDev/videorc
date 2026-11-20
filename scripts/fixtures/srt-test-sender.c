// Plan 255 (D18): a test SRT caller for `pnpm smoke:srt-camera`, built on
// the libsrt Videorc ships. It sends an MPEG-TS file in 7 x 188 = 1316-byte
// messages, paced by the file's PCR, so the camera gets a clean feed.
//
//   srt-test-sender LIB HOST PORT PASSPHRASE FILE [--loop] [--pairing]
//
// It prints one line per state, flushed at once, for the smoke to read:
//   CONNECTED          the camera accepted the call
//   REJECTED <code>    the camera refused it; <code> is srt_getrejectreason
//   LOST <error>       the connection dropped while sending
//   DONE               the file ended (without --loop)
// --pairing connects, sends nothing and waits; SIGINT or SIGTERM closes the
// connection politely in every mode. SIGKILL leaves it dead, on purpose.
#include <arpa/inet.h>
#include <dlfcn.h>
#include <netinet/in.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

#define TS_PACKET 188
#define CHUNK_PACKETS 7
#define SRTO_PASSPHRASE 26
#define SRTO_TRANSTYPE 50
#define SRTT_LIVE 0

typedef int (*fn_void)(void);
typedef int (*fn_setsockflag)(int, int, const void *, int);
typedef int (*fn_connect)(int, const struct sockaddr *, int);
typedef int (*fn_sendmsg2)(int, const char *, int, void *);
typedef int (*fn_socket)(int);
typedef const char *(*fn_error_str)(void);

static volatile sig_atomic_t stop_requested = 0;

static void on_stop(int signal_number) {
  (void)signal_number;
  stop_requested = 1;
}

static void *need(void *library, const char *name) {
  void *symbol = dlsym(library, name);
  if (!symbol) {
    fprintf(stderr, "missing %s in libsrt\n", name);
    exit(2);
  }
  return symbol;
}

static double now_seconds(void) {
  struct timespec clock;
  clock_gettime(CLOCK_MONOTONIC, &clock);
  return (double)clock.tv_sec + (double)clock.tv_nsec / 1e9;
}

// The 27 MHz PCR of one TS packet, or -1 when it carries none.
static int64_t packet_pcr(const unsigned char *packet) {
  if (packet[0] != 0x47 || !(packet[3] & 0x20) || packet[4] < 7 || !(packet[5] & 0x10)) {
    return -1;
  }
  const unsigned char *p = packet + 6;
  int64_t base = ((int64_t)p[0] << 25) | ((int64_t)p[1] << 17) | ((int64_t)p[2] << 9) |
                 ((int64_t)p[3] << 1) | (p[4] >> 7);
  int64_t extension = ((int64_t)(p[4] & 1) << 8) | p[5];
  return base * 300 + extension;
}

int main(int argc, char **argv) {
  if (argc < 6) {
    fprintf(stderr, "usage: %s LIB HOST PORT PASSPHRASE FILE [--loop] [--pairing]\n", argv[0]);
    return 2;
  }
  int loop = 0;
  int pairing = 0;
  for (int index = 6; index < argc; index++) {
    loop |= strcmp(argv[index], "--loop") == 0;
    pairing |= strcmp(argv[index], "--pairing") == 0;
  }
  signal(SIGINT, on_stop);
  signal(SIGTERM, on_stop);
  signal(SIGPIPE, SIG_IGN);

  void *library = dlopen(argv[1], RTLD_NOW | RTLD_LOCAL);
  if (!library) {
    fprintf(stderr, "cannot load %s: %s\n", argv[1], dlerror());
    return 2;
  }
  fn_void srt_startup = (fn_void)need(library, "srt_startup");
  fn_void srt_create_socket = (fn_void)need(library, "srt_create_socket");
  fn_setsockflag srt_setsockflag = (fn_setsockflag)need(library, "srt_setsockflag");
  fn_connect srt_connect = (fn_connect)need(library, "srt_connect");
  fn_sendmsg2 srt_sendmsg2 = (fn_sendmsg2)need(library, "srt_sendmsg2");
  fn_socket srt_close = (fn_socket)need(library, "srt_close");
  fn_socket srt_getrejectreason = (fn_socket)need(library, "srt_getrejectreason");
  fn_error_str srt_getlasterror_str = (fn_error_str)need(library, "srt_getlasterror_str");

  srt_startup();
  int sock = srt_create_socket();
  int live = SRTT_LIVE;
  srt_setsockflag(sock, SRTO_TRANSTYPE, &live, sizeof live);
  srt_setsockflag(sock, SRTO_PASSPHRASE, argv[4], (int)strlen(argv[4]));

  struct sockaddr_in address;
  memset(&address, 0, sizeof address);
  address.sin_len = sizeof address;
  address.sin_family = AF_INET;
  address.sin_port = htons((uint16_t)atoi(argv[3]));
  if (inet_pton(AF_INET, argv[2], &address.sin_addr) != 1) {
    fprintf(stderr, "bad host %s\n", argv[2]);
    return 2;
  }
  if (srt_connect(sock, (struct sockaddr *)&address, sizeof address) < 0) {
    printf("REJECTED %d\n", srt_getrejectreason(sock));
    fflush(stdout);
    srt_close(sock);
    return 3;
  }
  printf("CONNECTED\n");
  fflush(stdout);

  if (pairing) {
    while (!stop_requested) usleep(20000);
    srt_close(sock);
    return 0;
  }

  FILE *file = fopen(argv[5], "rb");
  if (!file) {
    fprintf(stderr, "cannot open %s\n", argv[5]);
    srt_close(sock);
    return 2;
  }
  unsigned char chunk[TS_PACKET * CHUNK_PACKETS];
  double started = now_seconds();
  int64_t first_pcr = -1;
  int64_t loop_offset = 0;
  int64_t last_pcr = -1;
  while (!stop_requested) {
    size_t read = fread(chunk, TS_PACKET, CHUNK_PACKETS, file);
    if (read == 0) {
      if (!loop) {
        printf("DONE\n");
        fflush(stdout);
        break;
      }
      // Restart the file; its clock carries on from the last PCR plus one
      // 25 fps frame, so the pace stays even across the loop.
      loop_offset += last_pcr - first_pcr + 27000000 / 25;
      first_pcr = -1;
      rewind(file);
      continue;
    }
    for (size_t packet = 0; packet < read; packet++) {
      int64_t pcr = packet_pcr(chunk + packet * TS_PACKET);
      if (pcr < 0) continue;
      if (first_pcr < 0) first_pcr = pcr;
      last_pcr = pcr;
      double due = started + (double)(loop_offset + pcr - first_pcr) / 27e6;
      double wait = due - now_seconds();
      if (wait > 0) usleep((useconds_t)(wait * 1e6));
    }
    if (srt_sendmsg2(sock, (const char *)chunk, (int)(read * TS_PACKET), NULL) < 0) {
      printf("LOST %s\n", srt_getlasterror_str());
      fflush(stdout);
      fclose(file);
      return 4;
    }
  }
  fclose(file);
  srt_close(sock);
  return 0;
}
