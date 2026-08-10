import { describe, it, expect } from 'vitest';
import { JsonParser } from '../src/modules/utils/JsonParser.js';

describe('JsonParser', () => {
    describe('parse', () => {
        it('should parse an object correctly into a node tree', () => {
            const json = '{"name":"John","age":30,"active":true,"tags":["admin","user"],"info":{"id":123}}';
            const node = JsonParser.parse(json);

            expect(node).toBeDefined();
            expect(node.type).toBe('object');
            expect(node.key).toBe('root');
            expect(node.children.length).toBe(5);

            // Primitive keys
            const nameNode = node.children.find(c => c.key === 'name');
            expect(nameNode.type).toBe('property');
            expect(nameNode.value).toBe('John');

            const ageNode = node.children.find(c => c.key === 'age');
            expect(ageNode.type).toBe('property');
            expect(ageNode.value).toBe(30);

            const activeNode = node.children.find(c => c.key === 'active');
            expect(activeNode.type).toBe('property');
            expect(activeNode.value).toBe(true);

            // Array key
            const tagsNode = node.children.find(c => c.key === 'tags');
            expect(tagsNode.type).toBe('array');
            expect(tagsNode.children.length).toBe(2);
            expect(tagsNode.children[0].value).toBe('admin');
            expect(tagsNode.children[1].value).toBe('user');

            // Object key
            const infoNode = node.children.find(c => c.key === 'info');
            expect(infoNode.type).toBe('object');
            expect(infoNode.children.length).toBe(1);
            expect(infoNode.children[0].key).toBe('id');
            expect(infoNode.children[0].value).toBe(123);
        });

        it('should parse a flat array correctly', () => {
            const json = '[1, 2, "three"]';
            const node = JsonParser.parse(json);

            expect(node.type).toBe('array');
            expect(node.children.length).toBe(3);
            expect(node.children[0].key).toBe('[0]');
            expect(node.children[0].value).toBe(1);
            expect(node.children[2].value).toBe('three');
        });

        it('should parse a single primitive value correctly', () => {
            const node = JsonParser.parse('"hello"');
            expect(node.type).toBe('string');
            expect(node.value).toBe('hello');
        });

        it('should throw an error for invalid JSON', () => {
            expect(() => {
                JsonParser.parse('{invalid}');
            }).toThrow('JSON Parsing Error');
        });
    });

    describe('stringify', () => {
        it('should stringify a node tree back to JSON string', () => {
            const originalObj = {
                name: 'Alice',
                age: 25,
                skills: ['JS', 'HTML'],
                address: { city: 'Tokyo' }
            };
            const node = JsonParser.jsonToNode(originalObj, 'root');
            const stringified = JsonParser.stringify(node);
            const parsed = JSON.parse(stringified);

            expect(parsed).toEqual(originalObj);
        });

        it('should stringify a single primitive property node', () => {
            const node = {
                type: 'property',
                key: 'item',
                value: 'test',
                children: []
            };
            const val = JsonParser.nodeToJson(node);
            expect(val).toBe('test');
        });
    });

    describe('getType', () => {
        it('should return correct type strings', () => {
            expect(JsonParser.getType(null)).toBe('null');
            expect(JsonParser.getType([])).toBe('array');
            expect(JsonParser.getType({})).toBe('object');
            expect(JsonParser.getType(42)).toBe('number');
            expect(JsonParser.getType('str')).toBe('string');
        });
    });
});
