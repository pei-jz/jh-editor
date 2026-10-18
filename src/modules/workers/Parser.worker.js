/**
 * Parser.worker.js
 * Web Worker for parsing structured data (XML, JSON, HTML) in the background.
 */
import { XmlParser } from '../utils/XmlParser.js';
import { JsonParser } from '../utils/JsonParser.js';
import { HtmlParser } from '../utils/HtmlParser.js';

self.onmessage = (e) => {
    const { content, type, requestId } = e.data;
    
    try {
        let parser;
        // parse() is static on all three; an instance has no parse method.
        if (type === 'xml') parser = XmlParser;
        else if (type === 'json') parser = JsonParser;
        else if (type === 'html') parser = HtmlParser;
        else throw new Error('Unknown parser type: ' + type);

        const rootNode = parser.parse(content);
        
        self.postMessage({ 
            success: true, 
            rootNode, 
            requestId 
        });
    } catch (err) {
        self.postMessage({ 
            success: false, 
            error: err.toString(), 
            requestId 
        });
    }
};
