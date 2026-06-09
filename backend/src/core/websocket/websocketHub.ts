import type { WebSocket } from "@fastify/websocket";
import type { RealtimeEvent } from "../../types/domain.js";

export class WebSocketHub {
  private readonly clients = new Set<WebSocket>();

  add(client: WebSocket): void {
    this.clients.add(client);
    client.on("close", () => this.clients.delete(client));
    client.on("error", () => this.clients.delete(client));
  }

  publish(event: RealtimeEvent): void {
    const encoded = JSON.stringify(event);
    for (const client of this.clients) {
      if (client.readyState !== 1) {
        this.clients.delete(client);
        continue;
      }
      client.send(encoded);
    }
  }

  clientCount(): number {
    return this.clients.size;
  }
}
