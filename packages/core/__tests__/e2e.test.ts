/**
 * This test is a mock implementation of the end-to-end functionality
 * without actually creating WebSocket connections.
 */

import { RPCRequest, RPCResponse, StreamStart, StreamData, StreamEnd } from '../src/types';
import { generateMessageId } from '../src/protocol';

describe('End-to-end interaction', () => {
  // Mock WebSocket implementation
  class MockWebSocket {
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    onopen: (() => void) | null = null;
    onerror: ((err: any) => void) | null = null;
    readyState = 1; // WebSocket.OPEN
    
    send(data: string) {
      if (this.peer) {
        const peerRef = this.peer;
        setTimeout(() => {
          if (peerRef.onmessage) {
            peerRef.onmessage({ data });
          }
        }, 0);
      }
    }
    
    close() {
      this.peer = null;
      this.onclose?.();
    }
    
    peer: MockWebSocket | null = null;
  }
  
  // Create a pair of connected mock WebSockets
  function createSocketPair(): [MockWebSocket, MockWebSocket] {
    const socket1 = new MockWebSocket();
    const socket2 = new MockWebSocket();
    
    socket1.peer = socket2;
    socket2.peer = socket1;
    
    return [socket1, socket2];
  }
  
  // Test RPC functionality
  it('should successfully make an RPC call and receive a response', async () => {
    const [clientSocket, serverSocket] = createSocketPair();
    
    // Server setup
    serverSocket.onmessage = ({ data }) => {
      const message = JSON.parse(data) as RPCRequest;
      
      if (message.type === 'rpc-request' && message.procedure === 'greet') {
        const name = message.params;
        const response: RPCResponse = {
          id: message.id,
          type: 'rpc-response',
          result: `Hello, ${name}!`
        };
        
        serverSocket.send(JSON.stringify(response));
      }
    };
    
    // Client makes RPC request
    const requestPromise = new Promise<string>((resolve, reject) => {
      const requestId = generateMessageId();
      
      // Set up response handler
      clientSocket.onmessage = ({ data }) => {
        const message = JSON.parse(data) as RPCResponse;
        
        if (message.type === 'rpc-response' && message.id === requestId) {
          if (message.error) {
            reject(new Error(message.error.message));
          } else {
            resolve(message.result);
          }
        }
      };
      
      // Send request
      const request: RPCRequest = {
        id: requestId,
        type: 'rpc-request',
        procedure: 'greet',
        params: 'World'
      };
      
      clientSocket.send(JSON.stringify(request));
    });
    
    const result = await requestPromise;
    expect(result).toBe('Hello, World!');
  });
  
  // Test streaming functionality
  it('should successfully stream data from server to client', async () => {
    const [clientSocket, serverSocket] = createSocketPair();
    const messageId = generateMessageId();
    const streamedData: string[] = [];
    
    // Set up client to receive streamed data
    clientSocket.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      
      if (message.type === 'stream-data' && message.id === messageId) {
        streamedData.push(message.data);
      } else if (message.type === 'stream-end' && message.id === messageId) {
        // Stream completed
      }
    };
    
    // Server setup to handle stream start request
    serverSocket.onmessage = ({ data }) => {
      const message = JSON.parse(data) as StreamStart;
      
      if (message.type === 'stream-start' && message.procedure === 'countToThree') {
        // Send three data messages
        for (let i = 1; i <= 3; i++) {
          const dataMessage: StreamData = {
            id: message.id,
            type: 'stream-data',
            data: i.toString()
          };
          
          serverSocket.send(JSON.stringify(dataMessage));
        }
        
        // Send stream end message
        const endMessage: StreamEnd = {
          id: message.id,
          type: 'stream-end'
        };
        
        serverSocket.send(JSON.stringify(endMessage));
      }
    };
    
    // Start the stream
    const streamStartMessage: StreamStart = {
      id: messageId,
      type: 'stream-start',
      procedure: 'countToThree',
      params: {}
    };
    
    clientSocket.send(JSON.stringify(streamStartMessage));
    
    // Wait for all data to be received
    await new Promise(resolve => setTimeout(resolve, 50));
    
    expect(streamedData).toEqual(['1', '2', '3']);
  });
  
  // Test error handling
  it('should handle RPC errors properly', async () => {
    const [clientSocket, serverSocket] = createSocketPair();
    
    // Server setup with error response
    serverSocket.onmessage = ({ data }) => {
      const message = JSON.parse(data) as RPCRequest;
      
      if (message.type === 'rpc-request' && message.procedure === 'failingMethod') {
        const response: RPCResponse = {
          id: message.id,
          type: 'rpc-response',
          error: {
            message: 'Test error occurred',
            code: 500
          }
        };
        
        serverSocket.send(JSON.stringify(response));
      }
    };
    
    // Client makes RPC request that will fail
    const requestPromise = new Promise<string>((resolve, reject) => {
      const requestId = generateMessageId();
      
      // Set up response handler
      clientSocket.onmessage = ({ data }) => {
        const message = JSON.parse(data) as RPCResponse;
        
        if (message.type === 'rpc-response' && message.id === requestId) {
          if (message.error) {
            reject(new Error(message.error.message));
          } else {
            resolve(message.result);
          }
        }
      };
      
      // Send request
      const request: RPCRequest = {
        id: requestId,
        type: 'rpc-request',
        procedure: 'failingMethod',
        params: {}
      };
      
      clientSocket.send(JSON.stringify(request));
    });
    
    await expect(requestPromise).rejects.toThrow('Test error occurred');
  });
});