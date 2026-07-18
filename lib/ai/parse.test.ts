import { describe, it, expect } from 'vitest';
import { extractText, stripCodeFences, extractJsonObject } from './parse';
import { makeTextMessage } from './mock-message';

describe('extractText', () => {
  it('concatenates text blocks', () => {
    expect(extractText(makeTextMessage('hello world'))).toBe('hello world');
  });
});

describe('stripCodeFences', () => {
  it('removes ```json and ``` fences', () => {
    expect(stripCodeFences('```json\n{"a":1}\n```').trim()).toBe('{"a":1}');
  });
});

describe('extractJsonObject', () => {
  it('parses a bare JSON object', () => {
    expect(extractJsonObject('{"score": 80, "reason": "ok"}')).toEqual({ score: 80, reason: 'ok' });
  });

  it('parses a fenced JSON object', () => {
    expect(extractJsonObject('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
  });

  it('parses JSON wrapped in prose', () => {
    expect(extractJsonObject('Here is the result: {"a": 1}. Done.')).toEqual({ a: 1 });
  });

  it('throws when no object is present', () => {
    expect(() => extractJsonObject('no json here')).toThrow(/No JSON object/);
  });

  it('throws on invalid JSON', () => {
    expect(() => extractJsonObject('{not valid}')).toThrow();
  });
});
