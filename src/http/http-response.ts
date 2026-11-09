export interface HttpResponse {
  status(code: number): HttpResponse;
  json(body: unknown): void;
  type(value: string): HttpResponse;
  send(value: string): void;
}
