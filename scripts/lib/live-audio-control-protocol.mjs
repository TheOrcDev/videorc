export function successfulLiveCommandReplies(output) {
  return output.match(/\bret:0\s+res:/g) ?? []
}
