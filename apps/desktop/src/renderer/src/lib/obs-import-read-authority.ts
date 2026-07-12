export type ObsImportReadTicket = Readonly<{
  generation: number
  collection: string
  profile: string
}>

export class ObsImportReadAuthority {
  private generation = 0

  begin(collection: string, profile: string): ObsImportReadTicket {
    this.generation += 1
    return { generation: this.generation, collection, profile }
  }

  invalidate(): void {
    this.generation += 1
  }

  accepts(ticket: ObsImportReadTicket): boolean {
    return ticket.generation === this.generation
  }
}
