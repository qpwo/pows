import { ProtocolMessage } from './types';

/**
 * Serialize a message to send over the WebSocket
 */
export function serializeMessage(message: ProtocolMessage): string {
  return JSON.stringify(message);
}

/**
 * Parse a message received from the WebSocket
 */
export function parseMessage(data: string): ProtocolMessage {
  try {
    return JSON.parse(data) as ProtocolMessage;
  } catch (error) {
    throw new Error(`Failed to parse message: ${error}`);
  }
}

/**
 * Generate a unique message ID
 */
export function generateMessageId(): string {
  return Math.random().toString(36).substring(2, 15) + 
         Math.random().toString(36).substring(2, 15);
}