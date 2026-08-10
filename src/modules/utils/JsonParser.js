
/**
 * JsonParser.js
 * Converts JSON string <-> Generic Node Tree
 */

export class JsonParser {
    static parse(jsonString) {
        try {
            const data = JSON.parse(jsonString);
            return this.jsonToNode(data, 'root', 'root');
        } catch (e) {
            throw new Error("JSON Parsing Error: " + e.message);
        }
    }

    static jsonToNode(data, key, typeOverride) {
        const node = {
            id: Math.random().toString(36).substr(2, 9),
            type: typeOverride || this.getType(data),
            key: key,
            value: null,
            children: [],
            expanded: true
        };

        if (Array.isArray(data)) {
            node.type = 'array';
            data.forEach((item, index) => {
                const child = this.jsonToNode(item, `[${index}]`);
                node.children.push(child);
            });
        } else if (typeof data === 'object' && data !== null) {
            node.type = 'object';
            Object.keys(data).forEach(prop => {
                const child = this.jsonToNode(data[prop], prop);
                child.type = 'property'; // JSON object keys are properties
                // Correction: In JSON, the property implies the child value's type.
                // But our tree needs a node for the Property (Key) which contains the Value.
                // If the Value is an Object, the Property Node has an Object Child?
                // Or does the Property Node BECOME the Object Node?

                // Generic Tree Model:
                // { key: "name", value: "John", type: "property" }
                // { key: "address", type: "object", children: [...] }

                // Let's refine based on StructureEditor logic:
                // Logic: Key displayed, Value displayed.

                if (typeof data[prop] === 'object' && data[prop] !== null) {
                    // Complex Property
                    // The child IS the property node, but its type reflects the value's handling (can expand)
                    child.type = Array.isArray(data[prop]) ? 'array' : 'object';
                    child.key = prop; // Key is the property name
                } else {
                    // Primitive Property
                    child.type = 'property';
                    child.key = prop;
                    child.value = data[prop];
                    // If logic requires specific type info (string vs number), add meta?
                    // For now, value type is enough.
                }
                node.children.push(child);
            });
        } else {
            // Primitive Root or Item
            node.value = data;
            if (node.type === 'root') {
                // Single value JSON
                node.type = typeof data;
            }
        }

        return node;
    }

    static getType(data) {
        if (data === null) return 'null';
        if (Array.isArray(data)) return 'array';
        return typeof data;
    }

    static stringify(rootNode) {
        const obj = this.nodeToJson(rootNode);
        return JSON.stringify(obj, null, 2);
    }

    static nodeToJson(node) {
        if (node.type === 'array') {
            const arr = [];
            node.children.forEach(child => {
                arr.push(this.nodeToJson(child));
            });
            return arr;
        } else if (node.type === 'object' || node.type === 'root') {
            // Root can be object or array, but here we cover object case
            const obj = {};
            node.children.forEach(child => {
                obj[child.key] = this.nodeToJson(child);
            });
            return obj;
        } else if (node.type === 'property') {
            // Property node in our tree:
            // If calls nodeToJson recursively, it generally returns the VALUE.
            // Because parent object loop uses child.key as key.

            // If property has children (it shouldn't if primitive, unless we changed logic), recurse?
            // In our parse logic:
            // Complex props became 'object'/'array' type nodes with 'key'. 
            // Primitive props became 'property' type nodes with 'value'.

            return node.value;
        } else {
            // Primitive (captured in value)
            return node.value;
        }
    }
}
