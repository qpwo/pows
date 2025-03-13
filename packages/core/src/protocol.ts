import { ProtocolMessage } from './types';

// Pre-allocate buffer for message ID to avoid string concatenation
let messageIdCounter = 0;
const MAX_COUNTER = 0x7FFFFFFF; // Max safe integer value to avoid overflow issues

/**
 * Serialize a message to send over the WebSocket
 * Direct JSON.stringify is already optimized in modern JS engines
 */
export function serializeMessage(message: ProtocolMessage): string {
  return JSON.stringify(message);
}

/**
 * Parse a message received from the WebSocket
 * Try-catch simplified for better performance
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
 * Optimized implementation with minimal string operations
 */
export function generateMessageId(): string {
  // Increment counter and reset if it gets too large
  messageIdCounter = (messageIdCounter + 1) % MAX_COUNTER;
  
  // Use timestamp and counter to ensure uniqueness
  // toString(36) is used for compact representation
  return Date.now().toString(36) + '-' + messageIdCounter.toString(36);
}