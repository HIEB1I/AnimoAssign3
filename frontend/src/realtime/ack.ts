import type { Socket } from "socket.io-client";

export function emitAck<TResp = any>(socket: Socket, event: string, payload: any): Promise<TResp> {
  return new Promise((resolve) => {
    socket.emit(event, payload, (resp: TResp) => resolve(resp));
  });
}
