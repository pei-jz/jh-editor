/**
 * MermaidRecipes.js — the data behind the Mermaid helper.
 *
 * The problem this solves: Mermaid's syntax is easy to *read* and hard to
 * *recall*. Every diagram type has its own arrow spelling, its own way to add a
 * note, its own shape vocabulary — so writing one always turns into a web
 * search. Here each diagram type carries:
 *
 *   • `template` — a working, non-trivial starting point (never an empty shell)
 *   • `snippets` — the handful of lines people actually look up, ready to insert
 *
 * Kept as plain data (no DOM, no imports) so it is trivially testable and can be
 * reused by any UI — the picker, autocomplete, or an AI prompt.
 */

export const MERMAID_RECIPES = [
    {
        id: 'flowchart',
        title: 'Flowchart',
        subtitle: 'Steps and branches',
        keywords: ['flowchart', 'graph', 'flow', 'branch', 'process', 'decision'],
        template: [
            'flowchart TD',
            '    Start([Start]) --> Input[/Input/]',
            '    Input --> Check{Condition met?}',
            '    Check -->|Yes| Do[Run the task]',
            '    Check -->|No| Err[Show an error]',
            '    Do --> End([End])',
            '    Err --> End',
        ].join('\n'),
        snippets: [
            { label: 'Direction', code: 'flowchart TD', note: 'TD/TB (top-down) · LR (left-right) · RL · BT' },
            { label: 'Box (process)', code: 'A[Process]' },
            { label: 'Rounded (start / end)', code: 'A([Start])' },
            { label: 'Diamond (decision)', code: 'A{Condition?}' },
            { label: 'Parallelogram (I/O)', code: 'A[/Input/]' },
            { label: 'Cylinder (database)', code: 'A[(Database)]' },
            { label: 'Arrow', code: 'A --> B' },
            { label: 'Labelled arrow', code: 'A -->|Yes| B' },
            { label: 'Dotted arrow', code: 'A -.-> B' },
            { label: 'Thick arrow', code: 'A ==> B' },
            { label: 'Group', code: 'subgraph Name\n    A --> B\nend' },
            { label: 'Comment', code: '%% this is a comment' },
        ],
    },
    {
        id: 'sequence',
        title: 'Sequence Diagram',
        subtitle: 'Interactions over time',
        keywords: ['sequence', 'order', 'api', 'message', 'call'],
        template: [
            'sequenceDiagram',
            '    autonumber',
            '    actor U as User',
            '    participant F as Frontend',
            '    participant S as Server',
            '',
            '    U->>F: Performs an action',
            '    F->>S: API request',
            '    activate S',
            '    S-->>F: Response',
            '    deactivate S',
            '    F-->>U: Updates the screen',
        ].join('\n'),
        snippets: [
            { label: 'Participant (box)', code: 'participant S as Server' },
            { label: 'Participant (person)', code: 'actor U as User' },
            { label: 'Solid arrow (call)', code: 'A->>B: Message' },
            { label: 'Dashed arrow (reply)', code: 'B-->>A: Response' },
            { label: 'Self-call', code: 'A->>A: Internal work' },
            { label: 'Activation bar', code: 'activate S\n...\ndeactivate S' },
            { label: 'Auto-number the steps', code: 'autonumber' },
            { label: 'Note', code: 'Note right of S: Extra detail' },
            { label: 'Alternative paths', code: 'alt Success\n    S-->>F: OK\nelse Failure\n    S-->>F: NG\nend' },
            { label: 'Loop', code: 'loop Up to 3 times\n    F->>S: Retry\nend' },
            { label: 'Optional block', code: 'opt Cached\n    F->>F: Use the cache\nend' },
            { label: 'Parallel blocks', code: 'par Branch A\n    A->>B: x\nand Branch B\n    A->>C: y\nend' },
        ],
    },
    {
        id: 'class',
        title: 'Class Diagram',
        subtitle: 'Structure, inheritance, relations',
        keywords: ['class', 'inheritance', 'structure', 'uml', 'object'],
        template: [
            'classDiagram',
            '    class Animal {',
            '        +String name',
            '        +int age',
            '        +speak() void',
            '    }',
            '    class Dog {',
            '        +fetch() void',
            '    }',
            '    Animal <|-- Dog : inherits',
            '    Dog "1" --> "*" Toy : owns',
        ].join('\n'),
        snippets: [
            { label: 'Class definition', code: 'class Name {\n    +String field\n    +method() void\n}' },
            { label: 'Visibility', code: '+public  -private  #protected  ~package' },
            { label: 'Inheritance', code: 'Base <|-- Derived' },
            { label: 'Implements (interface)', code: 'Interface <|.. Impl' },
            { label: 'Composition (strong ownership)', code: 'Whole *-- Part' },
            { label: 'Aggregation (weak ownership)', code: 'Whole o-- Part' },
            { label: 'Association', code: 'A --> B : label' },
            { label: 'Multiplicity', code: 'A "1" --> "*" B' },
            { label: 'Note', code: 'note for A "explanation"' },
            { label: 'Stereotype', code: 'class A {\n    <<interface>>\n}' },
        ],
    },
    {
        id: 'state',
        title: 'State Diagram',
        subtitle: 'State machine',
        keywords: ['state', 'transition', 'machine', 'status'],
        template: [
            'stateDiagram-v2',
            '    [*] --> Idle',
            '    Idle --> Running : start',
            '    Running --> Done : success',
            '    Running --> Failed : error',
            '    Failed --> Idle : retry',
            '    Done --> [*]',
        ].join('\n'),
        snippets: [
            { label: 'Start / end', code: '[*] --> State\nState --> [*]' },
            { label: 'Transition', code: 'A --> B : trigger' },
            { label: 'Composite state', code: 'state Parent {\n    [*] --> Child\n}' },
            { label: 'Parallel states', code: 'state Parallel {\n    [*] --> A\n    --\n    [*] --> B\n}' },
            { label: 'Choice', code: 'state Decision <<choice>>' },
            { label: 'Note', code: 'note right of A : explanation' },
        ],
    },
    {
        id: 'er',
        title: 'ER Diagram',
        subtitle: 'Tables and relationships',
        keywords: ['er', 'erd', 'table', 'db', 'database', 'relation', 'schema'],
        template: [
            'erDiagram',
            '    USER ||--o{ ORDER : "places"',
            '    ORDER ||--|{ ORDER_ITEM : "contains"',
            '    PRODUCT ||--o{ ORDER_ITEM : "refers to"',
            '',
            '    USER {',
            '        int id PK',
            '        string name',
            '        string email',
            '    }',
            '    ORDER {',
            '        int id PK',
            '        int user_id FK',
            '        datetime ordered_at',
            '    }',
        ].join('\n'),
        snippets: [
            { label: 'One to many', code: 'A ||--o{ B : "label"' },
            { label: 'One to one', code: 'A ||--|| B : "label"' },
            { label: 'Many to many', code: 'A }o--o{ B : "label"' },
            { label: 'One to one-or-more', code: 'A ||--|{ B : "label"' },
            { label: 'Symbol reference', code: '|| exactly one · o| zero or one · |{ one or more · o{ zero or more' },
            { label: 'Attributes', code: 'TABLE {\n    int id PK\n    string name\n    int other_id FK\n}' },
        ],
    },
    {
        id: 'gantt',
        title: 'Gantt Chart',
        subtitle: 'Schedule',
        keywords: ['gantt', 'schedule', 'timeline', 'plan', 'project'],
        template: [
            'gantt',
            '    title Project plan',
            '    dateFormat YYYY-MM-DD',
            '    axisFormat %m/%d',
            '',
            '    section Design',
            '    Requirements   :done,    a1, 2026-01-06, 5d',
            '    High-level     :active,  a2, after a1, 7d',
            '    section Build',
            '    Development    :         b1, after a2, 14d',
            '    Testing        :crit,    b2, after b1, 7d',
        ].join('\n'),
        snippets: [
            { label: 'Date format', code: 'dateFormat YYYY-MM-DD' },
            { label: 'Axis format', code: 'axisFormat %m/%d' },
            { label: 'Section', code: 'section Phase name' },
            { label: 'Task (fixed dates)', code: 'Task name : id1, 2026-01-06, 5d' },
            { label: 'Task (depends on)', code: 'Task name : id2, after id1, 7d' },
            { label: 'States', code: 'done · active · crit (critical)' },
            { label: 'Milestone', code: 'Release : milestone, m1, 2026-03-01, 0d' },
            { label: 'Hide the today marker', code: 'todayMarker off' },
        ],
    },
    {
        id: 'pie',
        title: 'Pie Chart',
        subtitle: 'Proportions',
        keywords: ['pie', 'chart', 'share', 'ratio', 'percentage'],
        template: [
            'pie showData',
            '    title Breakdown',
            '    "Design" : 30',
            '    "Build" : 45',
            '    "Test" : 25',
        ].join('\n'),
        snippets: [
            { label: 'Title', code: 'title Chart name' },
            { label: 'Slice', code: '"Label" : 42' },
            { label: 'Show the values', code: 'pie showData' },
        ],
    },
    {
        id: 'mindmap',
        title: 'Mind Map',
        subtitle: 'Organise ideas',
        keywords: ['mindmap', 'ideas', 'brainstorm', 'outline'],
        template: [
            'mindmap',
            '  root((Central theme))',
            '    Aspect A',
            '      Detail A1',
            '      Detail A2',
            '    Aspect B',
            '      Detail B1',
        ].join('\n'),
        snippets: [
            { label: 'Root (circle)', code: 'root((Theme))' },
            { label: 'Square node', code: 'id[Text]' },
            { label: 'Rounded node', code: 'id(Text)' },
            { label: 'Hierarchy', code: 'Indentation (spaces) defines parent/child' },
        ],
    },
    {
        id: 'journey',
        title: 'User Journey',
        subtitle: 'Experience and satisfaction',
        keywords: ['journey', 'experience', 'ux', 'customer'],
        template: [
            'journey',
            '    title Sign-up experience',
            '    section Research',
            '      Browse the site: 5: User',
            '      Compare options: 3: User',
            '    section Sign up',
            '      Fill the form: 2: User',
            '      Confirmation: 5: User, Staff',
        ].join('\n'),
        snippets: [
            { label: 'Section', code: 'section Stage' },
            { label: 'Step (score 1-5)', code: 'Step name: 3: Actor' },
            { label: 'Several actors', code: 'Step name: 5: User, Staff' },
        ],
    },
];

/** Look a recipe up by id. */
export function getRecipe(id) {
    return MERMAID_RECIPES.find(r => r.id === id) || null;
}

/**
 * Filter recipes by a free-text query (title / subtitle / keywords / id).
 * An empty query returns everything, so the picker can render its default list
 * through the same path.
 */
export function searchRecipes(query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return MERMAID_RECIPES;
    return MERMAID_RECIPES.filter(r =>
        r.id.includes(q)
        || r.title.toLowerCase().includes(q)
        || r.subtitle.toLowerCase().includes(q)
        || r.keywords.some(k => k.toLowerCase().includes(q))
    );
}

/**
 * Guess which diagram type a block of Mermaid source is, so the cheat-sheet can
 * follow what the user is actually editing.
 */
export function detectDiagramType(code) {
    const firstLine = String(code || '')
        .split('\n')
        .map(l => l.trim())
        .find(l => l && !l.startsWith('%%'));
    if (!firstLine) return null;
    const head = firstLine.toLowerCase();

    if (head.startsWith('flowchart') || head.startsWith('graph')) return 'flowchart';
    if (head.startsWith('sequencediagram')) return 'sequence';
    if (head.startsWith('classdiagram')) return 'class';
    if (head.startsWith('statediagram')) return 'state';
    if (head.startsWith('erdiagram')) return 'er';
    if (head.startsWith('gantt')) return 'gantt';
    if (head.startsWith('pie')) return 'pie';
    if (head.startsWith('mindmap')) return 'mindmap';
    if (head.startsWith('journey')) return 'journey';
    return null;
}

/** Wrap Mermaid source in a fenced block ready to drop into a Markdown doc. */
export function toMarkdownBlock(code) {
    return '```mermaid\n' + String(code || '').replace(/\s+$/, '') + '\n```';
}
