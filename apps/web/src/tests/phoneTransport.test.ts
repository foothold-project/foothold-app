import { describe, expect, it } from 'vitest';
import { phonePorts, phoneUrl } from '../phoneTransport';

const page = (url: string) => new URL(url);
const agent = 'ws://127.0.0.1:9433/phone/ws';
describe('phone preview transport', () => {
  it('keeps localhost direct for control and camera', () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      expect(phoneUrl(agent, page(`http://${host}:5190`))).toBe(agent);
      expect(phoneUrl(agent, page(`http://${host}:5190`), true)).toBe(agent.replace('/ws', '/camera/ws'));
    }
  });
  it('uses the page host with TLS and the same fixed agent port', () => {
    expect(phoneUrl(agent, page('https://example.trycloudflare.com'))).toBe('wss://example.trycloudflare.com/__fh_phone/9433/phone/ws');
    expect(phoneUrl(agent, page('http://preview.invalid:9480'), true)).toBe('ws://preview.invalid:9480/__fh_phone/9433/phone/camera/ws');
  });
  it('rejects remote hosts, credentials, query, fragments and ports outside the range', () => {
    for (const address of ['ws://evil.invalid:9433/phone/ws', 'ws://127.0.0.1:8453/phone/ws',
      'ws://user@127.0.0.1:9433/phone/ws', `${agent}?x=1`, `${agent}#x`, agent.replace('/phone/ws', '/api/v1/ws')]) {
      expect(phoneUrl(address, page('https://example.trycloudflare.com'))).toBeNull();
    }
  });
  it('uses an explicitly configured bounded range on external pages', () => {
    expect(phonePorts('9434:9434')).toEqual([9434]);
    expect(phoneUrl(agent, page('https://example.trycloudflare.com'), false, phonePorts('9434:9434'))).toBeNull();
    for (const range of ['0:65535', '9489:9480', '9430', '9430:65536', '1:2']) expect(phonePorts(range)).toEqual([]);
  });
});
