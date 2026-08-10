
export const CodeFormatter = {
    format(content, type) {
        switch (type.toLowerCase()) {
            case 'json':
                return this.formatJSON(content);
            case 'xml':
            case 'html':
                return this.formatXML(content);
            case 'sql':
                return this.formatSQL(content);
            case 'java':
            case 'javascript':
            case 'js':
            case 'ts':
            case 'typescript':
                return this.formatCStyle(content);
            default:
                return content;
        }
    },

    formatJSON(content) {
        try {
            const obj = JSON.parse(content);
            return JSON.stringify(obj, null, 2);
        } catch (e) {
            console.error('JSON Format Error', e);
            return content; // Return original if invalid
        }
    },

    formatXML(content) {
        let formatted = '';
        let reg = /(>)(<)(\/*)/g;
        let xml = content.replace(reg, '$1\r\n$2$3');
        let pad = 0;
        xml.split('\r\n').forEach((node) => {
            let indent = 0;
            if (node.match(/.+<\/\w[^>]*>$/)) {
                indent = 0;
            } else if (node.match(/^<\/\w/)) {
                if (pad != 0) pad -= 1;
            } else if (node.match(/^<\w[^>]*[^\/]>.*$/)) {
                indent = 1;
            } else {
                indent = 0;
            }

            let padding = '';
            for (let i = 0; i < pad; i++) {
                padding += '  ';
            }

            formatted += padding + node + '\r\n';
            pad += indent;
        });

        return formatted.trim();
    },

    formatSQL(content) {
        // Basic SQL Formatter (Uppercase Keywords + Newline)
        const keywords = [
            'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'ORDER BY', 'GROUP BY',
            'INSERT INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'CREATE TABLE',
            'DROP TABLE', 'ALTER TABLE', 'HAVING', 'LIMIT', 'JOIN', 'LEFT JOIN', 'RIGHT JOIN'
        ];

        let formatted = content;
        // Normalize spaces
        formatted = formatted.replace(/\s+/g, ' ');

        // Uppercase keywords
        // Note: This is invasive if user has mixed case columns, but requested style implies standardization.
        // Safer: Regex match casing insensitive and replace with uppercase
        keywords.forEach(kw => {
            const regex = new RegExp(`\\b${kw}\\b`, 'gi');
            formatted = formatted.replace(regex, `\n${kw}`);
        });

        // specific cleanups
        formatted = formatted.replace(/^\s+/, '');
        formatted = formatted.replace(/,/g, ',\n\t');

        return formatted;
    },

    formatCStyle(content) {
        // 1. Mask strings and comments to avoid breaking them
        const masks = [];
        let maskedContent = content.replace(/("(?:\\.|[^"])*"|'(?:\\.|[^'])*'|`[^`]*`|\/\*[\s\S]*?\*\/|\/\/.*)/g, (match) => {
            masks.push(match);
            return `__MASKED_${masks.length - 1}__`;
        });

        // 2. Normalize newlines and basic spacing
        // Force exactly one space before { and a newline after
        maskedContent = maskedContent.replace(/\s*\{/g, ' {\n'); 
        // Add newline before and after }
        maskedContent = maskedContent.replace(/\s*\}/g, '\n}\n');
        // Add newline after ; (ignoring those inside parentheses like for loops)
        maskedContent = maskedContent.replace(/;(?![^(]*\))/g, ';\n');
        // Add space between keywords and parentheses
        maskedContent = maskedContent.replace(/\b(if|for|while|switch|catch)\(/g, '$1 (');

        // Restore masks
        let unmasked = maskedContent.replace(/__MASKED_(\d+)__/g, (match, index) => {
            return masks[parseInt(index)];
        });

        // 3. Cleanup: remove multiple newlines, trim lines
        let lines = unmasked.split(/\r?\n/).map(l => l.trim()).filter(l => l !== '');

        // 4. Indentation pass
        let pad = 0;
        let formatted = [];
        const indentStr = '    ';
        
        for (let line of lines) {
            if (line.match(/^[\}\]]/)) {
                pad = Math.max(0, pad - 1);
            }

            formatted.push(indentStr.repeat(pad) + line);
            
            let closingCount = (line.match(/[\}\]]/g) || []).length;
            let openingCount = (line.match(/[\{\[]/g) || []).length;
            let net = openingCount - closingCount;
            
            if (!line.match(/^[\}\]]/)) {
                 pad = Math.max(0, pad + net);
            } else {
                 pad = Math.max(0, pad + net + 1);
            }
        }
        return formatted.join('\n');
    }
};
