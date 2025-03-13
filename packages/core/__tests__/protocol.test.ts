import { serializeMessage, parseMessage, generateMessageId } from '../src/protocol';
import { RPCRequest } from '../src/types';

describe('Protocol utilities', () => {
  describe('serializeMessage', () => {
    it('should serialize a message to JSON', () => {
      const message: RPCRequest = {
        id: '123',
        type: 'rpc-request',
        procedure: 'test',
        params: { foo: 'bar' }
      };
      
      const serialized = serializeMessage(message);
      expect(serialized).toBe('{"id":"123","type":"rpc-request","procedure":"test","params":{"foo":"bar"}}');
    });
  });
  
  describe('parseMessage', () => {
    it('should parse a JSON message', () => {
      const json = '{"id":"123","type":"rpc-request","procedure":"test","params":{"foo":"bar"}}';
      
      const parsed = parseMessage(json);
      expect(parsed).toEqual({
        id: '123',
        type: 'rpc-request',
        procedure: 'test',
        params: { foo: 'bar' }
      });
    });
    
    it('should throw an error for invalid JSON', () => {
      const invalidJson = '{"id":"123",';
      
      expect(() => parseMessage(invalidJson)).toThrow();
    });
  });
  
  describe('generateMessageId', () => {
    it('should generate a string', () => {
      const id = generateMessageId();
      expect(typeof id).toBe('string');
    });
    
    it('should generate unique IDs', () => {
      const ids = new Set();
      for (let i = 0; i < 100; i++) {
        ids.add(generateMessageId());
      }
      
      expect(ids.size).toBe(100);
    });
  });
});