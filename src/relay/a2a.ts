/**
 * A2A (Agent2Agent, Linux Foundation) conformance layer — v1.0.0 of the spec.
 *
 * Why this exists: A2A assumes an agent is an HTTP server at a domain. A can2cup
 * agent is a Claude Code process on somebody's laptop — no domain, no inbound
 * port, not always awake. The relay already stands in for that laptop, so it is
 * also the natural place to host the agent's A2A surface.
 *
 * What is conformant here and what deliberately is not:
 *   - The Agent Card, the JSON-RPC envelope, the error codes and the security
 *     scheme follow the spec exactly. Do not invent fields.
 *   - can2cup's own semantics (the principal's outbound mandate, and the ed25519
 *     per-message signature over a hash-chained transcript) have no home in the
 *     spec — A2A does per-agent-card JWS but explicitly no per-message signing,
 *     and expresses no principal->agent authority at all. They are therefore
 *     declared as A2A extensions, which is the sanctioned way to add meaning
 *     without forking. Both are `required: false`, so an agent that has never
 *     heard of can2cup can still talk to us.
 *   - The room stays can2cup's model. A2A's Task is a delegated unit of work with
 *     a terminal state; a room is an ongoing multi-party ordered log. We map
 *     `contextId` to the room id at the boundary and keep RoomDO unchanged.
 *
 * INGEST IS CLOSED BY DEFAULT. An inbound A2A message cannot be signed by the
 * sender's can2cup key (the relay holds no private key, and an external agent has
 * no can2cup identity), so admitting one means writing a relay-attested envelope
 * into a transcript whose whole value is that every entry is participant-signed.
 * That is the same trust downgrade as the LINE `/a` path, which is why it is
 * marked UNVERIFIED there. Until a room opts in, message/send answers with the
 * spec's UnsupportedOperation — which is also exactly what a non-opted-in room
 * will answer once ingest ships, so this endpoint does not lie about itself.
 */
import { PROTOCOL_VERSION } from "../protocol/index.js";

export const A2A_PROTOCOL_VERSION = "1.0.0";
export const A2A_AGENT_VERSION = "0.6.0";

/** JSON-RPC 2.0 plus the A2A-specific range. */
export const RPC = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  taskNotFound: -32001,
  taskNotCancelable: -32002,
  pushNotificationNotSupported: -32003,
  unsupportedOperation: -32004,
  contentTypeNotSupported: -32005,
} as const;

/** Extension identifiers are namespaced under the relay's own origin, so they
 *  are dereferenceable by whoever is actually running this deployment. */
export const extUri = (origin: string, name: string): string => `${origin}/ext/${name}/v1`;

export interface CardOptions {
  origin: string;
  relayPub?: string;
}

export function agentCard(o: CardOptions): unknown {
  return {
    protocolVersion: A2A_PROTOCOL_VERSION,
    name: "can2cup relay",
    description:
      "Hosts the A2A surface for personal agents that have no server of their own. " +
      "Each can2cup room is an ordered, hash-chained transcript between agents that each answer " +
      "to a different human principal; this gateway lets an A2A caller reach one.",
    version: A2A_AGENT_VERSION,
    url: `${o.origin}/a2a`,
    preferredTransport: "JSONRPC",
    provider: { organization: "can2cup", url: o.origin },
    documentationUrl: `${o.origin}/`,

    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["text/plain", "application/json"],

    capabilities: {
      // Truthful, not aspirational. Flip these in the same commit that implements them.
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: false,
      extensions: [
        {
          uri: extUri(o.origin, "principal-mandate"),
          description:
            "Outbound messages are gated on the sending agent's machine by a mandate its human principal " +
            "wrote: disclosure limits, a commitment ceiling, and what authority it may delegate. A blocked " +
            "message is never sent, and the agent reports task state input-required rather than failed. " +
            "A2A expresses no principal-to-agent authority, so this is carried out of band and declared here.",
          required: false,
        },
        {
          uri: extUri(o.origin, "signed-transcript"),
          description:
            "Every participant message carries an ed25519 signature over a canonical envelope whose prev field " +
            "is the hash of the previous entry, so the room is a hash chain. The relay additionally signs a " +
            "transcript head (seq, hash, time) on every read, which lets a client that pinned the relay key " +
            "prove a fork or a truncated tail after the fact. A2A signs the agent card (JWS) but specifies " +
            "no per-message signing; callers that do not implement this extension are stored relay-attested " +
            "and shown to participants as UNVERIFIED.",
          required: false,
        },
      ],
    },

    securitySchemes: {
      participantCap: {
        type: "http",
        scheme: "bearer",
        description:
          "A participant capability for one room, issued by POST /rooms/:id/join to the key that signed the " +
          "join. The invite secret is a join-and-read key and is not accepted here.",
      },
    },
    security: [{ participantCap: [] }],

    skills: [
      {
        id: "room-message",
        name: "Send a message into a can2cup room",
        description:
          "Deliver a message to the participants of one room. contextId must be the room's 12-hex id and the " +
          "bearer token must be a participant capability for that room. Ingest is opt-in per room: a room that " +
          "has not enabled it answers -32004 UnsupportedOperation.",
        tags: ["messaging", "relay", "room", "agent-to-agent"],
        examples: ["Send a review request into room 77ff7ca1be69"],
        inputModes: ["text/plain"],
        outputModes: ["text/plain"],
      },
      {
        id: "room-transcript",
        name: "Read a room transcript",
        description:
          "Return a room's ordered, hash-chained transcript from a given sequence number, together with the " +
          "relay-signed head. Available today over the native REST surface at GET /rooms/:id/messages.",
        tags: ["history", "audit", "hash-chain"],
        inputModes: ["application/json"],
        outputModes: ["application/json"],
      },
    ],

    // Informational: how to reach the native surface this gateway fronts.
    additionalInterfaces: [{ transport: "HTTP+JSON", url: `${o.origin}/rooms` }],
  };
}

interface RpcReq { jsonrpc?: string; id?: unknown; method?: unknown; params?: unknown }

const err = (id: unknown, code: number, message: string, data?: unknown): Response =>
  Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data ? { data } : {}) } });

/**
 * JSON-RPC entry point. Every method the card claims is routed here; the ones we
 * have not built answer with the spec's own codes rather than a 404, so a caller
 * gets a machine-readable reason instead of a broken endpoint.
 */
export async function handleA2A(req: Request, origin: string): Promise<Response> {
  if (req.method !== "POST") return err(null, RPC.invalidRequest, "A2A JSON-RPC requires POST");

  let body: RpcReq;
  try {
    body = (await req.json()) as RpcReq;
  } catch {
    return err(null, RPC.parseError, "invalid JSON");
  }

  const id = body.id ?? null;
  if (body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    return err(id, RPC.invalidRequest, 'jsonrpc must be "2.0" and method must be a string');
  }

  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";

  switch (body.method) {
    case "message/send":
    case "message/stream": {
      if (!token) {
        return err(id, RPC.invalidRequest, "a participant capability is required (Authorization: Bearer <cap>)");
      }
      const p = body.params as { message?: { contextId?: string } } | undefined;
      const room = p?.message?.contextId ?? "";
      if (!/^[0-9a-f]{12}$/.test(room)) {
        return err(id, RPC.invalidParams, "message.contextId must be a 12-hex can2cup room id");
      }
      return err(id, RPC.unsupportedOperation, `room ${room} has not enabled A2A ingest`, {
        reason: "ingest-not-enabled",
        detail:
          "A can2cup transcript is participant-signed end to end. An inbound A2A message cannot carry that " +
          "signature, so admitting it writes a relay-attested entry that participants see as UNVERIFIED. " +
          "The room's creator must opt in before this is allowed.",
        extension: extUri(origin, "signed-transcript"),
      });
    }

    case "tasks/get":
      return err(id, RPC.taskNotFound, "no tasks exist: this gateway does not yet create A2A tasks");

    case "tasks/pushNotificationConfig/set":
    case "tasks/pushNotificationConfig/get":
      return err(id, RPC.pushNotificationNotSupported, "push notifications are not implemented on this gateway");

    case "agent/getAuthenticatedExtendedCard":
      return Response.json({ jsonrpc: "2.0", id, result: agentCard({ origin }) });

    default:
      return err(id, RPC.methodNotFound, `unknown method: ${body.method}`);
  }
}

/** Compile-time tie to the can2cup protocol version this gateway fronts. */
export const PARLEY_PROTOCOL = PROTOCOL_VERSION;
