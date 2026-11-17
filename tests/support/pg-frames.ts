/** PostgreSQL wire frames a test's proxy answers with (protocol-message-formats). */

/** An ErrorResponse of `severity` and SQLSTATE `code`: what a pooler answers for its broken server connection. */
export function errorResponse(code: string, message: string, severity = "FATAL"): Uint8Array {
  const fields = Buffer.concat(
    [
      ["S", severity],
      ["V", severity],
      ["C", code],
      ["M", message],
    ].map(([type, value]) => Buffer.from(`${String(type)}${String(value)}\0`, "utf8")),
  );
  const body = Buffer.concat([fields, Buffer.from([0])]);
  const length = Buffer.alloc(4);
  length.writeInt32BE(body.length + 4);
  return Buffer.concat([Buffer.from("E"), length, body]);
}

/** ReadyForQuery, idle: the session takes the next statement. */
export const READY_FOR_QUERY_IDLE: Uint8Array = Buffer.from([0x5a, 0, 0, 0, 5, 0x49]);
