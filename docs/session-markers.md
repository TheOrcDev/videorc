# Session markers

During a recording or livestream, open Stream Manager and type
`/marker Shadcn New Library`. This saves a titled point at the current capture
time. `/marker` saves an untitled point. The command works without connected
chat destinations, including recording-only sessions and streams with Record
turned off. Its confirmation shows the timestamp and offers Undo.

For voice creation, enable Orcle and Listen, sign in with Premium, and allow
Cloud AI processing. Stream Manager shows whether voice markers are listening
or blocked. Say “Orcle, make a marker here for Shadcn New Library”, then pause.
“Orcle, add a marker called …” and “Orcle, mark this as …” also work. The point
uses the spoken command's capture time rather than the transcription's arrival
time. Transcription runs through the existing caption provider; interpreting
the marker command does not make an additional cloud command-parser request.

Titles can contain up to 120 Unicode characters. Keep them on one line.
The saved spelling comes from the typed input or transcription and can be
renamed later. If part of the command audio was missed or the title cannot be
assigned to one speech turn, Videorc asks you to repeat the command. Turning
off consent or Listen cancels pending voice marker work.
If the service temporarily pauses voice commands, Stream Manager shows the
blocked reason. Turn Listen off and on after the pause ends to start a fresh
voice admission; queued audio from before the pause cannot create a marker.

In Library, open **Session actions → Markers** to view the titles, sources and
timestamps. Select a row or timeline pin to seek to that point in the original
local video. Rename and delete are available there. The Orcle report also
links to Markers. A stream without a local recording retains its timestamp
list; it cannot play a local video. Markers refer to the original capture and
are not remapped onto a Clean Cut export.

`/help` displays local command help. Unknown leading slash commands produce a
local error. Start a chat message with `//` to send a literal leading slash;
for example, `//marker example` sends `/marker example` to the selected chat
destinations. Slashes inside ordinary messages and URLs keep their normal
meaning.

Named markers are points where a topic starts. The existing “clip that” and
Mark clip actions remain separate retrospective clip hints, and report Moments
remain ranges. Creating new markers while watching a saved recording is not
part of this feature.

Storage is local SQLite metadata attached to the capture session. Manual
creation uses a persistent operation ID so a retry can recover the saved
result after a lost reply or Stop. Delete retains an operation receipt without
the title so retry cannot recreate an undone marker. Session deletion removes
its marker metadata along with the session.
