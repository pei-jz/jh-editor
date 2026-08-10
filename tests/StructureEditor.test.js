import { describe, it, expect, beforeEach } from 'vitest';
import { StructureEditor } from '../src/modules/editors/StructureEditor.js';

describe('StructureEditor Logic', () => {
    let editor;
    let mockData;

    beforeEach(() => {
        // Create a dummy DOM container
        const container = document.createElement('div');
        
        // Create a generic tree model simulating JSON/XML parsing structure
        mockData = {
            id: 'root',
            type: 'root',
            key: 'root',
            children: [
                {
                    id: 'node1',
                    type: 'object',
                    key: 'person',
                    children: [
                        { id: 'node2', type: 'property', key: 'name', value: 'John' },
                        { id: 'node3', type: 'property', key: 'age', value: 30 }
                    ]
                },
                {
                    id: 'node4',
                    type: 'array',
                    key: 'items',
                    children: [
                        { id: 'node5', type: 'text', value: 'Item A' },
                        { id: 'node6', type: 'text', value: 'Item B' }
                    ]
                }
            ]
        };

        editor = new StructureEditor(container, mockData, () => {}, () => {});
    });

    it('should find nodes by ID using findNodeInternal', () => {
        const found = editor.findNodeInternal(mockData, 'node3');
        expect(found).toBeDefined();
        expect(found.key).toBe('age');
        expect(found.value).toBe(30);

        const notFound = editor.findNodeInternal(mockData, 'nonexistent');
        expect(notFound).toBeNull();
    });

    it('should find parents by child ID using findParentInternal', () => {
        const parent = editor.findParentInternal(mockData, 'node5');
        expect(parent).toBeDefined();
        expect(parent.id).toBe('node4');
        expect(parent.key).toBe('items');

        const rootParent = editor.findParentInternal(mockData, 'node1');
        expect(rootParent.id).toBe('root');
    });

    it('should simplify generic node structures to plain JS objects using simplifyNode', () => {
        // Test primitive property
        const nameNode = editor.findNodeInternal(mockData, 'node2');
        expect(editor.simplifyNode(nameNode)).toBe('John');

        // Test object node
        const personNode = editor.findNodeInternal(mockData, 'node1');
        const simplifiedPerson = editor.simplifyNode(personNode);
        expect(simplifiedPerson).toEqual({
            person: ['John', 30] // Note: internal structure stores property leaves as values
        });
    });

    it('should build hierarchical paths using getNodePath', () => {
        const path = editor.getNodePath(mockData, 'node3');
        // Path should include root -> node1 -> node3
        expect(path.length).toBe(3);
        expect(path[0].id).toBe('root');
        expect(path[1].id).toBe('node1');
        expect(path[2].id).toBe('node3');
    });
});
