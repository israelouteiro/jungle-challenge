export abstract class PendingReferenceReader {
  abstract dueIds(limit: number): Promise<string[]>;
}
