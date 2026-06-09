import WebSocket from "ws";

const url = process.env.WS_URL ?? "ws://localhost:3000/ws";
const socket = new WebSocket(url);

socket.on("open", () => {
  console.log(`Connected to ${url}`);
  console.log("Listening for realtime events. Press Ctrl+C to exit.");
});

socket.on("message", (data) => {
  const raw = data.toString();
  try {
    const event = JSON.parse(raw) as { type?: string; payload?: unknown };
    console.log(`\n[${new Date().toISOString()}] ${event.type ?? "unknown"}`);
    console.dir(event.payload, { depth: null, colors: true });
  } catch {
    console.log(raw);
  }
});

socket.on("error", (error) => {
  console.error("WebSocket error:", error.message);
});

socket.on("close", (code, reason) => {
  const text = reason.toString();
  console.log(
    `Disconnected from ${url}. code=${code}${text ? ` reason=${text}` : ""}`,
  );
});
