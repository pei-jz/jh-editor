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
        if (type === 'xml') parser = new XmlParser();
        else if (type === 'json') parser = new JsonParser();
        else if (type === 'html') parser = new HtmlParser();
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
