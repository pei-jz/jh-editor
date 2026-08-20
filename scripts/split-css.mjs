import fs from 'fs';
import path from 'path';

const lines = fs.readFileSync('src/styles.css', 'utf-8').split('\n');

function getLines(ranges) {
    let result = [];
    for (const [start, end] of ranges) {
        result.push(...lines.slice(start - 1, end));
    }
    return result.join('\n');
}

const fileMap = {
    'themes.css': [[1, 149], [3223, 3318]],
    'base.css': [[150, 198], [1499, 1544], [3171, 3208]],
    'explorer.css': [[199, 344], [3209, 3222]],
    'layout.css': [[345, 600], [1545, 1620], [1837, 1936], [2001, 2055], [3320, 3353]],
    'editor.css': [
        [601, 851], [1001, 1175], [1281, 1432], // markdown related
        [1621, 1640], [1666, 1836], // plain text
        [2182, 2385], [3538, 3618] // highlights and plain text
    ],
    'outline.css': [[852, 908]],
    'modals.css': [[909, 1000], [1433, 1498], [1641, 1665], [1937, 2000], [2386, 2465], [3619, 3624]],
    'csv.css': [[1176, 1280], [2056, 2181]],
    'structure.css': [[2466, 2959], [3354, 3537]],
    'diff.css': [[2960, 3170]],
    'ai.css': [[3625, 3779]]
};

// Make styles directory if not exists
if (!fs.existsSync('src/styles')) {
    fs.mkdirSync('src/styles');
}

for (const [filename, ranges] of Object.entries(fileMap)) {
    fs.writeFileSync(`src/styles/${filename}`, getLines(ranges));
    console.log(`Wrote src/styles/${filename}`);
}

// Generate an index.css that imports all of them
const imports = Object.keys(fileMap).map(filename => `@import './${filename}';`).join('\n');
fs.writeFileSync('src/styles/index.css', imports + '\n');
console.log('Wrote src/styles/index.css');

console.log('Done splitting CSS!');
