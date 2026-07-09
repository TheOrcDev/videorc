export class SmokeAppQuitGuard {
  private quitAllowed = false

  constructor(private readonly enabled: boolean) {}

  shouldPreventQuit(): boolean {
    return this.enabled && !this.quitAllowed
  }

  allowQuit(): void {
    this.quitAllowed = true
  }
}
