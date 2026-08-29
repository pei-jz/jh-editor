/**
 * TaskNotificationPanel.js — Lightweight Task Panel for JHEditor
 * 
 * Displays task status, progress, and approval requests from the external
 * J.H AI Agent. Replaces the old internal Agent mode UI.
 * 
 * Features:
 * - Task submission form (prompt + workspace)
 * - Live task list (running / completed / failed)
 * - Progress bars and status updates
 * - Approval request handling (confirm/deny)
 * - Completion reports with modified file list
 */

import { State } from '../core/Store.js';
import { t } from '../utils/I18n.js';
import { icon as svgIcon } from '../ui/Icons.js';
import { showAlert } from '../ui/Dialog.js';

export class TaskNotificationPanel {
    constructor() {
        this.tasks = [];
        this.sockets = new Map();
        this.element = null;
        this.isVisible = false;
        this.hostUrl = '';
        this.token = '';
        this.activeTabId = 'new-task';
        this._fetchingTaskDiff = {};
    }

    init(parentElement, file = null) {
        this.file = file;
        this.activeTabId = 'new-task';
        if (file && file.path && file.path !== 'agent://tasks') {
            const match = file.path.match(/^agent:\/\/tasks\/(.+)$/);
            if (match) {
                this.activeTabId = match[1];
            }
        }

        this.element = document.createElement('div');
        this.element.className = 'task-notification-panel';
        this.element.innerHTML = this._renderPanel();
        parentElement.appendChild(this.element);
        this._bindEvents();
        this._loadSettings();
    }

    async _loadSettings() {
        // Discovery order: standard JH config path → localStorage override → fallback.
        // See src/modules/ai/ConnectionConfig.js for the full lookup rules.
        const { getConnectionConfig } = await import('./ConnectionConfig.js');
        const cfg = await getConnectionConfig();
        this.hostUrl = cfg.hostUrl;
        this.token = cfg.token;
    }

    _renderPanel() {
        return `
            <div class="tnp-editor-wrap">
                <div class="tnp-header" data-tauri-drag-region>
                    <div class="tnp-title">
                        <span class="tnp-icon">${svgIcon('robot', { size: 15 })}</span>
                        <span>Agent Tasks Control Panel</span>
                        <span class="tnp-badge" id="tnp-task-count" style="display: none;">0</span>
                    </div>
                    <div class="tnp-header-actions">
                        <button id="tnp-refresh-btn" class="tnp-btn-icon" title="Refresh connection" data-i18n-title="Refresh connection">${svgIcon('refresh', { size: 13 })}<span>Refresh Connection</span></button>
                        <span id="tnp-status-dot" class="tnp-status-dot offline" title="Disconnected"></span>
                    </div>
                </div>

                <!-- Horizontal scrollable tab bar for tasks (hidden as we use separate editor tabs now) -->
                <div class="tnp-tabs" id="tnp-tabs" style="display: none;"></div>

                <!-- Body container for the active tab content -->
                <div class="tnp-body" id="tnp-body-content"></div>
            </div>
        `;
    }

    _bindEvents() {
        const refreshBtn = this.element.querySelector('#tnp-refresh-btn');
        refreshBtn?.addEventListener('click', () => this._checkConnection());

        this._onProjectSwitched = (e) => {
            const input = this.element.querySelector('#tnp-workspace-input');
            if (input) input.value = e.detail.path || State.currentDir || '';
        };
        window.addEventListener('app:project-switched', this._onProjectSwitched);

        // Initial connection check
        this._checkConnection();
    }

    async _checkConnection() {
        const dot = this.element.querySelector('#tnp-status-dot');
        await this._loadSettings();
        
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 2000);
            const res = await fetch(`${this.hostUrl}/api/health`, { signal: controller.signal });
            clearTimeout(timeoutId);
            
            if (res.ok) {
                dot.className = 'tnp-status-dot online';
                dot.title = t('Connected to J.H AI Agent');
                this.isOffline = false;
                await this._fetchTasks();
            } else {
                dot.className = 'tnp-status-dot offline';
                dot.title = t('Agent not responding');
                this.isOffline = true;
                this._renderTaskList();
            }
        } catch (e) {
            dot.className = 'tnp-status-dot offline';
            dot.title = t('Agent offline');
            this.isOffline = true;
            this._renderTaskList();
        }
    }

    /** Fetch a single task's full detail (GET /tasks/:id) — includes the
     *  persisted `modified_files` [{path, original, current}] needed to open a
     *  diff for a task whose list entry only carried file paths. */
    async _fetchTaskDetail(taskId) {
        try {
            const res = await fetch(`${this.hostUrl}/api/tasks/${encodeURIComponent(taskId)}`, {
                headers: { 'Authorization': `Bearer ${this.token}` }
            });
            if (!res.ok) return null;
            const detail = await res.json();
            // Cache back into the local task so re-renders don't re-fetch.
            const task = this.tasks.find(t => t.id === taskId);
            if (task && Array.isArray(detail.modified_files) && detail.modified_files.length > 0) {
                task.modifiedFiles = detail.modified_files.map(m => ({
                    path: m.path,
                    original: m.original ?? null,
                    current: m.current ?? ''
                }));
            }
            return detail;
        } catch (e) {
            console.warn('Failed to fetch task detail:', e);
            return null;
        }
    }

    async _fetchTasks() {
        try {
            const res = await fetch(`${this.hostUrl}/api/tasks`, {
                headers: { 'Authorization': `Bearer ${this.token}` }
            });
            if (res.ok) {
                const tasks = await res.json();
                
                // Process logs to reconstruct messages, modified files, final responses
                tasks.forEach(t => this._processTaskLogs(t));
                
                this.tasks = tasks;
                State.agentTasks = tasks;
                window.dispatchEvent(new CustomEvent('app:agent-tasks-updated', { detail: { tasks } }));

                // Automatically connect WebSocket for the active task of this panel if it is running
                if (this.activeTabId !== 'new-task') {
                    const activeTask = this.tasks.find(t => t.id === this.activeTabId);
                    if (activeTask && activeTask.status === 'running' && !this.sockets.has(activeTask.id)) {
                        const wsHost = this.hostUrl.replace(/^http/, 'ws');
                        const wsUrl = `${wsHost}/ws/tasks/${activeTask.id}?token=${this.token}`;
                        this._connectTaskWS(activeTask.id, wsUrl, activeTask);
                    }
                }

                this._renderTaskList();
            }
        } catch (e) {
            console.warn('Failed to fetch tasks:', e);
        }
    }

    _processTaskLogs(task) {
        task.messages = [];
        task.modifiedFiles = [];
        task.finalResponse = '';
        task.errorMessage = '';

        // History tasks come from GET /tasks, which strips `logs` but now carries
        // the persisted `modified_files` ([{path, original, current}]) added by the
        // Rust TaskInfo. Prefer it when present so completed history tasks can
        // still re-open their diffs without a detail fetch.
        if (Array.isArray(task.modified_files) && task.modified_files.length > 0) {
            task.modifiedFiles = task.modified_files.map(m => ({
                path: m.path,
                original: m.original ?? null,
                current: m.current ?? ''
            }));
        }

        if (!task.logs || !Array.isArray(task.logs)) return;

        task.logs.forEach(log => {
            const eventType = log.event;
            const data = log.data;
            if (!eventType || !data) return;

            switch (eventType) {
                case 'status':
                    task.status = data.status || task.status;
                    task.progress = data.progress || task.progress;
                    task.messages.push({ type: 'status', text: data.message || data.status });
                    break;

                case 'thought':
                    task.messages.push({ type: 'thought', text: data.text });
                    break;

                case 'tool_call':
                    task.messages.push({ type: 'tool', text: data.name });
                    break;

                case 'confirm_request':
                case 'plan_review':
                    task.messages.push({ type: 'approval', data: data, resolved: data.resolved !== undefined ? data.resolved : (log.resolved || false) });
                    break;

                case 'complete':
                    task.status = 'completed';
                    task.progress = 1.0;
                    task.modifiedFiles = data.modifiedFiles || [];
                    task.finalResponse = data.message || '';
                    break;

                case 'error':
                    task.status = 'failed';
                    task.errorMessage = data.error || 'Unknown error';
                    break;

                case 'file_modified':
                    if (data.path) {
                        const exists = task.modifiedFiles.some(f => (typeof f === 'string' ? f : f.path) === data.path);
                        if (!exists) {
                            task.modifiedFiles.push(data);
                        }
                    }
                    break;
            }
        });
    }

    async _submitTask() {
        const promptInput = this.element.querySelector('#tnp-prompt-input');
        const workspaceInput = this.element.querySelector('#tnp-workspace-input');
        const prompt = promptInput?.value?.trim();
        if (!prompt) return;

        await this._loadSettings();

        try {
            const res = await fetch(`${this.hostUrl}/api/tasks`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.token}`
                },
                body: JSON.stringify({
                    prompt: prompt,
                    workspace_path: workspaceInput?.value?.trim() || State.currentDir || null,
                    caller: "JHEditor",
                    // Behavior MUST be an object — the previous string form was
                    // silently dropped by the Rust AgentBehavior deserialization.
                    // Omitting `system_prompt` lets the agent server use its
                    // built-in heavy prompt with all safety rules.
                    behavior: { mode: "iterative_agent" }
                })
            });

            if (!res.ok) {
                const errText = await res.text();
                showAlert(`Failed to create task: ${errText}`, { title: 'Task', kind: 'error' });
                return;
            }

            const taskData = await res.json();
            const { task_id, ws_url } = taskData;
            
            // Clear input
            promptInput.value = '';

            // Add task to local list
            const newTask = {
                id: task_id,
                prompt: prompt,
                status: 'running',
                progress: 0,
                messages: [],
                modifiedFiles: [],
                startedAt: new Date().toISOString(),
                workspace_path: workspaceInput?.value?.trim() || State.currentDir || null
            };
            this.tasks.unshift(newTask);
            State.agentTasks = this.tasks;
            window.dispatchEvent(new CustomEvent('app:agent-tasks-updated', { detail: { tasks: this.tasks } }));

            // Open the new task in its own dedicated editor tab
            if (window.app && window.app.openAgentTasksTab) {
                window.app.openAgentTasksTab(task_id);
            }

            // Re-render the form tab
            this._renderTaskList();

        } catch (e) {
            showAlert(`Agent Error: ${e.message}`, { title: 'Agent', kind: 'error' });
        }
    }

    _connectTaskWS(taskId, wsUrl, task) {
        const socket = new WebSocket(wsUrl);
        this.sockets.set(taskId, socket);

        // Clear local messages to prevent duplicates during websocket replay of historical logs
        task.messages = [];

        socket.onmessage = (event) => {
            try {
                const packet = JSON.parse(event.data);
                const { event: eventType, data } = packet;

                switch (eventType) {
                    case 'status':
                        task.status = data.status || 'running';
                        task.progress = data.progress || task.progress;
                        task.messages.push({ type: 'status', text: data.message || data.status });
                        break;

                    case 'thought':
                        task.messages.push({ type: 'thought', text: data.text });
                        break;

                    case 'tool_call':
                        task.messages.push({ type: 'tool', text: data.name });
                        break;

                    case 'confirm_request':
                    case 'plan_review':
                        task.messages.push({ type: 'approval', data: data, resolved: false });
                        this._renderTaskList();
                        this._showApprovalUI(taskId, task.messages.length - 1, data, socket);
                        return;

                    case 'complete':
                        task.status = 'completed';
                        task.progress = 1;
                        task.completedAt = new Date().toISOString();
                        task.modifiedFiles = data.modifiedFiles || [];
                        task.finalResponse = data.message || '';
                        socket.close();
                        this.sockets.delete(taskId);
                        this._notifyComplete(task);
                        break;

                    case 'error':
                        task.status = 'failed';
                        task.errorMessage = data.error || 'Unknown error';
                        socket.close();
                        this.sockets.delete(taskId);
                        break;

                    case 'file_modified':
                        if (data.path) {
                            task.modifiedFiles.push(data.path);
                            // Auto reload file in editor
                            if (window.app && window.app.reloadFileSilently) {
                                window.app.reloadFileSilently(data.path);
                            }
                            if (window.app && window.app.refreshExplorer) {
                                window.app.refreshExplorer();
                            }
                        }
                        break;

                    default:
                        break;
                }

                this._renderTaskList();
                State.agentTasks = this.tasks;
                window.dispatchEvent(new CustomEvent('app:agent-tasks-updated', { detail: { tasks: this.tasks } }));
            } catch (e) {
                console.error('Task WS parse error:', e);
            }
        };

        socket.onerror = () => {
            task.status = 'failed';
            task.errorMessage = 'Connection lost';
            this._renderTaskList();
            State.agentTasks = this.tasks;
            window.dispatchEvent(new CustomEvent('app:agent-tasks-updated', { detail: { tasks: this.tasks } }));
        };

        socket.onclose = () => {
            this.sockets.delete(taskId);
        };
    }

    _notifyComplete(task) {
        // Show desktop notification if available
        if ('Notification' in window && Notification.permission === 'granted') {
            new Notification('J.H AI Agent — Task Complete', {
                body: task.prompt.substring(0, 100),
                icon: 'robot'
            });
        }
    }

    _showApprovalUI(taskId, msgIndex, data, socket) {
        // After render, bind approval buttons
        setTimeout(() => {
            const approveBtn = this.element.querySelector(`#tnp-approve-${taskId}-${msgIndex}`);
            const denyBtn = this.element.querySelector(`#tnp-deny-${taskId}-${msgIndex}`);
            
            approveBtn?.addEventListener('click', () => {
                socket.send(JSON.stringify({ 
                    event: 'confirm_response', 
                    data: {
                        confirmId: data.confirmId,
                        approved: true
                    }
                }));
                const task = this.tasks.find(t => t.id === taskId);
                if (task && task.messages[msgIndex]) {
                    task.messages[msgIndex].resolved = true;
                    task.messages[msgIndex].approved = true;
                }
                this._renderTaskList();
            });

            denyBtn?.addEventListener('click', () => {
                socket.send(JSON.stringify({ 
                    event: 'confirm_response', 
                    data: {
                        confirmId: data.confirmId,
                        approved: false
                    }
                }));
                const task = this.tasks.find(t => t.id === taskId);
                if (task && task.messages[msgIndex]) {
                    task.messages[msgIndex].resolved = true;
                    task.messages[msgIndex].approved = false;
                }
                this._renderTaskList();
            });
        }, 0);
    }

    _renderTaskList() {
        const tabsEl = this.element.querySelector('#tnp-tabs');
        const bodyContentEl = this.element.querySelector('#tnp-body-content');
        const badge = this.element.querySelector('#tnp-task-count');
        
        // Update task count badge in header
        const runningCount = this.tasks.filter(t => t.status === 'running').length;
        if (badge) {
            badge.textContent = runningCount;
            badge.style.display = runningCount > 0 ? 'inline-flex' : 'none';
        }

        // Render Tabs
        if (tabsEl) {
            let tabsHtml = `
                <div class="tnp-tab-item ${this.activeTabId === 'new-task' ? 'active' : ''}" data-tab-id="new-task">
                    <span class="jh-icon-row">${svgIcon('plus', { size: 13 })}New Task</span>
                </div>
            `;
            
            tabsHtml += this.tasks.map(task => {
                const shortId = task.id.substring(0, 8);
                const statusIcon = svgIcon(
                task.status === 'completed' ? 'check-circle'
                : task.status === 'failed' ? 'x-circle'
                : 'clock', { size: 13 });
                const isActive = this.activeTabId === task.id;
                return `
                    <div class="tnp-tab-item ${isActive ? 'active' : ''}" data-tab-id="${task.id}" title="${this._escapeHtml(task.prompt)}">
                        <span>${statusIcon} #${shortId}</span>
                    </div>
                `;
            }).join('');
            
            tabsEl.innerHTML = tabsHtml;
            
            // Bind tab click events
            tabsEl.querySelectorAll('.tnp-tab-item').forEach(tabItem => {
                tabItem.onclick = () => {
                    this.activeTabId = tabItem.dataset.tabId;
                    this._renderTaskList();
                };
            });
        }

        // Render Active Tab Content
        if (bodyContentEl) {
            if (this.activeTabId === 'new-task') {
                if (this.isOffline) {
                    bodyContentEl.innerHTML = `
                        <div class="tnp-empty-state" style="padding: 24px; text-align: center; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; height: 100%;">
                            <span>${svgIcon('plug', { size: 32 })}</span>
                            <span style="font-size: 15px; font-weight: bold; color: var(--error-color, #ff4d4f);">J.H AI Agent Server is offline</span>
                            <span class="tnp-empty-hint" style="max-width: 400px; line-height: 1.5; margin-bottom: 12px;">
                                The editor could not reach the agent. Check that the agent server is running.
                            </span>
                            <div style="text-align: left; background: var(--surface-sunken); border: 1px solid var(--border-color); border-radius: 6px; padding: 12px; font-size: 12px; max-width: 400px; width: 100%; box-sizing: border-box;">
                                <strong class="jh-icon-row" style="margin-bottom: 6px;">${svgIcon('lightbulb', { size: 13 })}To reconnect:</strong>
                                <ol style="margin: 0; padding-left: 18px; line-height: 1.6; opacity: 0.8;">
                                    <li>Start the <strong>J.H AI Agent</strong> app.</li>
                                    <li>In the agent, press <strong>Settings → General → Export Connection</strong>.</li>
                                    <li>Or enter the connection details by hand in <strong>Settings → Agent</strong>.</li>
                                </ol>
                            </div>
                            <button id="tnp-retry-conn-btn" class="primary-btn" style="padding: 8px 16px; font-size: 12px; margin-top: 10px; cursor: pointer;">
                                Test the connection again
                            </button>
                        </div>
                    `;
                    const retryBtn = bodyContentEl.querySelector('#tnp-retry-conn-btn');
                    if (retryBtn) {
                        retryBtn.onclick = () => {
                            this._checkConnection();
                        };
                    }
                } else {
                    bodyContentEl.innerHTML = `
                        <div class="tnp-new-task">
                            <textarea id="tnp-prompt-input" class="tnp-prompt" placeholder="Describe the task for the AI Agent..." rows="6" style="font-size: 13px; padding: 12px;"></textarea>
                            <div class="tnp-form-row" style="display: flex; gap: 10px; align-items: flex-end;">
                                <div style="flex: 1; display: flex; flex-direction: column; gap: 4px;">
                                    <label style="font-size: 11px; opacity: 0.7; font-weight: 600;">Workspace Target Path</label>
                                    <input id="tnp-workspace-input" class="tnp-workspace" type="text" placeholder="Workspace path" value="${State.currentDir || ''}" style="width: 100%; height: 32px;" />
                                </div>
                                <button id="tnp-submit-btn" class="tnp-submit-btn" title="Submit Task" style="height: 32px; padding: 0 16px;">
                                    <span>${svgIcon('play', { size: 12 })}</span> Run Agent Task
                                </button>
                            </div>
                        </div>
                    `;
                    this._bindNewTaskFormEvents();
                }
            } else {
                const task = this.tasks.find(t => t.id === this.activeTabId);
                if (!task) {
                    bodyContentEl.innerHTML = `
                        <div class="tnp-empty-state">
                            <span>Task not found</span>
                            <span class="tnp-empty-hint">The task may have been deleted or does not exist.</span>
                        </div>`;
                } else {
                    const taskIdStr = task.id || '';
                    const shortId = taskIdStr.substring(0, 8);
                    const statusIcon = svgIcon(
                task.status === 'completed' ? 'check-circle'
                : task.status === 'failed' ? 'x-circle'
                : 'clock', { size: 13 });
                    const progressPct = Math.round((task.progress || 0) * 100);
                    
                    // Stats
                    const totalTokens = task.token_usage?.total_tokens || 0;
                    const promptTokens = task.token_usage?.prompt_tokens || 0;
                    const completionTokens = task.token_usage?.completion_tokens || 0;
                    const startedAtStr = task.startedAt ? new Date(task.startedAt).toLocaleTimeString() : (task.started_at ? new Date(task.started_at).toLocaleTimeString() : 'N/A');
                    const completedAtStr = task.completedAt ? new Date(task.completedAt).toLocaleTimeString() : (task.completed_at ? new Date(task.completed_at).toLocaleTimeString() : '');
                    
                    let statsHtml = `
                        <div class="tnp-detail-stats" style="display: flex; gap: 12px; font-size: 11px; opacity: 0.8; margin-top: 6px;">
                            <span class="jh-icon-row">${svgIcon('clock', { size: 12 })}Started: ${startedAtStr}</span>
                            ${completedAtStr ? `<span class="jh-icon-row">${svgIcon('flag', { size: 12 })}Finished: ${completedAtStr}</span>` : ''}
                            <span class="jh-icon-row">${svgIcon('coin', { size: 12 })}Tokens: ${totalTokens} (Prompt: ${promptTokens}, Completion: ${completionTokens})</span>
                        </div>
                    `;

                    // Approval Banner
                    let approvalHtml = '';
                    const pendingApproval = (task.messages || []).find(msg => msg.type === 'approval' && !msg.resolved);
                    if (pendingApproval) {
                        const globalIdx = (task.messages || []).indexOf(pendingApproval);
                        approvalHtml = `
                            <div class="tnp-msg-approval" style="margin-bottom: 16px; padding: 16px; background: var(--warning-soft); border: 1px solid rgba(255, 193, 7, 0.25); border-radius: 8px;">
                                <h4 style="margin: 0 0 8px 0; color: var(--warning-color); font-size: 13px; font-weight: bold; display: flex; align-items: center; gap: 6px;">
                                    Approval Required
                                </h4>
                                <div style="font-size: 13px; margin-bottom: 12px; line-height: 1.4;">
                                    ${pendingApproval.data?.message || 'The agent requires your confirmation to proceed.'}
                                </div>
                                ${pendingApproval.data?.command ? `<pre style="background: var(--surface-sunken); padding: 8px; border-radius: 4px; font-family: monospace; font-size: 12px; margin-bottom: 12px; border: 1px solid rgba(255,255,255,0.05); overflow-x: auto; white-space: pre-wrap;">${this._escapeHtml(pendingApproval.data.command)}</pre>` : ''}
                                <div class="tnp-approval-actions" style="display: flex; gap: 8px; justify-content: flex-end;">
                                    <button id="tnp-approve-${task.id}-${globalIdx}" class="tnp-btn-approve" style="padding: 6px 14px; font-size: 11px; font-weight: bold;">${svgIcon('check', { size: 12 })}<span>Approve</span></button>
                                    <button id="tnp-deny-${task.id}-${globalIdx}" class="tnp-btn-deny" style="padding: 6px 14px; font-size: 11px; font-weight: bold;">${svgIcon('x', { size: 12 })}<span>Deny</span></button>
                                </div>
                            </div>
                        `;
                    }

                    // Progress / Latest Thought & Action
                    let runningProgressHtml = '';
                    if (task.status === 'running') {
                        const latestThought = [...(task.messages || [])].reverse().find(msg => msg.type === 'thought');
                        const latestAction = [...(task.messages || [])].reverse().find(msg => msg.type === 'tool' || msg.type === 'status');
                        
                        runningProgressHtml = `
                            <div class="tnp-detail-progress-card" style="padding: 12px; background: var(--primary-soft); border: 1px solid rgba(55, 148, 255, 0.15); border-radius: 8px; margin-bottom: 16px; display: flex; flex-direction: column; gap: 10px;">
                                <div style="display: flex; justify-content: space-between; align-items: center;">
                                    <span style="font-size: 12px; font-weight: 600; color: var(--primary-color);">⏳ Agent is executing...</span>
                                    <span style="font-size: 12px; font-weight: 700; color: var(--primary-color);">${progressPct}%</span>
                                </div>
                                <div class="tnp-progress-bar"><div class="tnp-progress-fill" style="width: ${progressPct}%"></div></div>
                                
                                ${latestThought ? `
                                    <div class="tnp-detail-latest-thought" style="font-size: 12px; color: var(--text-secondary); background: var(--surface-sunken); padding: 8px 10px; border-radius: 6px; border-left: 3px solid var(--primary-color);">
                                        <strong style="font-size: 10px; text-transform: uppercase; display: block; opacity: 0.6; margin-bottom: 4px; font-family: sans-serif;">Latest Thought</strong>
                                        <span style="font-style: italic;">"${this._escapeHtml(latestThought.text)}"</span>
                                    </div>
                                ` : ''}
                                
                                ${latestAction ? `
                                    <div class="tnp-detail-latest-action" style="font-size: 12px; display: flex; align-items: center; gap: 8px; background: rgba(0,0,0,0.1); padding: 6px 10px; border-radius: 6px;">
                                        <span>${svgIcon('bolt', { size: 14 })}</span>
                                        <span>${this._escapeHtml(latestAction.text)}</span>
                                    </div>
                                ` : ''}
                            </div>
                        `;
                    }

                    // Final response report
                    let finalResponseHtml = '';
                    if (task.status === 'completed' && task.finalResponse) {
                        const rendered = (typeof marked !== 'undefined') 
                            ? marked.parse(task.finalResponse)
                            : `<p>${this._escapeHtml(task.finalResponse)}</p>`;
                        finalResponseHtml = `
                            <div class="tnp-final-response" style="margin-bottom: 16px; padding: 16px; background: var(--surface-raised); border: 1px solid var(--border-color); border-radius: 8px;">
                                <h4 style="margin: 0 0 10px 0; font-size: 13px; font-weight: bold; color: var(--success-color); display: flex; align-items: center; gap: 6px;">
                                    Final Response / Report
                                </h4>
                                <div class="tnp-markdown-body" style="font-size: 13px; line-height: 1.5; color: var(--text-color); overflow-x: auto; user-select: text;">
                                    ${rendered}
                                </div>
                            </div>
                        `;
                    }

                    // Modified Files list with Diffs
                    let filesHtml = '';
                    const modifiedFiles = task.modifiedFiles || [];
                    if (task.status === 'completed' && modifiedFiles.length > 0) {
                        filesHtml = `
                            <div class="tnp-files" style="margin-bottom: 16px; padding: 16px; background: rgba(255,255,255,0.01); border: 1px solid var(--border-color); border-radius: 8px;">
                                <div class="tnp-files-title" style="font-size: 13px; font-weight: bold; color: var(--text-color); margin-bottom: 10px; display: flex; align-items: center; gap: 6px;">
                                    Modified / Created Files (${modifiedFiles.length})
                                </div>
                                <div style="display: flex; flex-direction: column; gap: 8px;">
                                    ${modifiedFiles.map((f, fIdx) => {
                                        const filePath = typeof f === 'string' ? f : (f.path || '');
                                        const basename = filePath.split(/[\\/]/).pop() || '?';
                                        const hasRichContent = typeof f === 'object' && f.original !== undefined && f.current !== undefined;
                                        return `
                                            <div class="tnp-file-row" style="display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; background: var(--surface-sunken); border: 1px solid rgba(255,255,255,0.03); border-radius: 6px; font-size: 12px;">
                                                <div style="display: flex; flex-direction: column; min-width: 0; text-align: left;">
                                                    <span style="font-weight: 600; text-overflow: ellipsis; overflow: hidden; white-space: nowrap;" class="jh-icon-row">${svgIcon('file', { size: 12 })}${basename}</span>
                                                    <span style="font-size: 10px; opacity: 0.6; text-overflow: ellipsis; overflow: hidden; white-space: nowrap; font-family: monospace;" title="${filePath}">${filePath}</span>
                                                </div>
                                                <div style="display: flex; gap: 8px; flex-shrink: 0; margin-left: 12px;">
                                                    <button class="tnp-btn-file-open jh-icon-row" data-path="${filePath}" style="padding: 4px 10px; font-size: 11px; background: var(--control-bg); border: 1px solid rgba(255,255,255,0.1); border-radius: 4px; color: var(--text-color); cursor: pointer;">${svgIcon('folder-open', { size: 11 })}Open</button>
                                                    ${filePath ? `
                                                        <button class="tnp-btn-file-diff jh-icon-row" data-task-id="${task.id}" data-file-idx="${fIdx}" style="padding: 4px 10px; font-size: 11px; background: var(--primary-color); border: none; border-radius: 4px; color: white; cursor: pointer; font-weight: 500;">${svgIcon('search', { size: 11 })}Diff</button>
                                                    ` : ''}
                                                </div>
                                            </div>
                                        `;
                                    }).join('')}
                                </div>
                            </div>
                        `;
                    }

                    // Error logs
                    let errorHtml = '';
                    if (task.status === 'failed' && task.errorMessage) {
                        errorHtml = `
                            <div class="tnp-error" style="margin-bottom: 16px; padding: 16px; background: rgba(244, 67, 54, 0.08); border: 1px solid rgba(244, 67, 54, 0.25); border-radius: 8px; color: #ff6b6b; font-size: 13px;">
                                <h4 class="jh-icon-row" style="margin: 0 0 6px 0; font-weight: bold; font-size: 13px;">${svgIcon('x-circle', { size: 13 })}Task Failed</h4>
                                <div>${task.errorMessage}</div>
                            </div>
                        `;
                    }

                    // Collapsible Activity history log
                    let activityLogHtml = '';
                    const allLogs = task.messages || [];
                    if (allLogs.length > 0) {
                        activityLogHtml = `
                            <details class="tnp-activity-details" style="margin-top: 16px; border: 1px solid var(--border-color); border-radius: 8px; background: rgba(0,0,0,0.1); text-align: left;">
                                <summary style="padding: 10px 14px; font-size: 12px; font-weight: 600; cursor: pointer; outline: none; user-select: none; color: var(--text-secondary); display: flex; align-items: center; justify-content: space-between;">
                                    <span class="jh-icon-row">${svgIcon('scroll', { size: 12 })}Activity Log (${allLogs.length} events)</span>
                                    <span class="tnp-details-arrow" style="opacity: 0.6;">${svgIcon('chevron-down', { size: 11 })}</span>
                                </summary>
                                <div class="tnp-activity-history-list" style="padding: 0 14px 14px 14px; display: flex; flex-direction: column; gap: 8px; max-height: 250px; overflow-y: auto; border-top: 1px solid rgba(255,255,255,0.05); padding-top: 12px;">
                                    ${allLogs.map(msg => {
                                        let styleClass = 'tnp-msg-status';
                                        if (msg.type === 'thought') styleClass = 'tnp-msg-thought';
                                        else if (msg.type === 'tool') styleClass = 'tnp-msg-tool';
                                        else if (msg.type === 'approval') styleClass = 'tnp-msg-resolved';
                                        
                                        return `<div class="tnp-msg ${styleClass}" style="margin: 0; padding: 6px 10px; word-break: break-all;">${this._escapeHtml(msg.text || (msg.type === 'approval' ? (msg.resolved ? 'Approved' : 'Denied') : ''))}</div>`;
                                    }).join('')}
                                </div>
                            </details>
                        `;
                    }

                    bodyContentEl.innerHTML = `
                        <div class="tnp-task-dashboard" style="display: flex; flex-direction: column; height: 100%; overflow-y: auto; padding-right: 4px; box-sizing: border-box;">
                            <!-- Detail Header -->
                            <div class="tnp-detail-header" style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 16px; border-bottom: 1px solid var(--border-color); padding-bottom: 12px; text-align: left;">
                                <div>
                                    <div style="display: flex; align-items: center; gap: 8px;">
                                        <span style="font-size: 20px;">${statusIcon}</span>
                                        <h3 style="margin: 0; font-size: 16px; font-weight: 700;">Task #${shortId}</h3>
                                        <span class="tnp-task-status tnp-task-${task.status}" style="font-size: 10px; padding: 2px 6px; border-radius: 4px; font-weight: bold; background: rgba(255,255,255,0.08); text-transform: uppercase;">
                                            ${task.status}
                                        </span>
                                    </div>
                                    ${statsHtml}
                                </div>
                            </div>
                            
                            <!-- Original Prompt Card -->
                            <div class="tnp-prompt-card" style="padding: 12px 16px; background: rgba(255, 255, 255, 0.02); border: 1px solid var(--border-color); border-radius: 8px; margin-bottom: 16px; text-align: left;">
                                <strong style="font-size: 10px; text-transform: uppercase; color: var(--text-secondary); display: block; opacity: 0.6; margin-bottom: 6px; font-family: sans-serif;">Prompt</strong>
                                <div style="font-size: 13px; line-height: 1.4; color: var(--text-color); font-weight: 500; font-style: italic; white-space: pre-wrap;">${this._escapeHtml(task.prompt)}</div>
                            </div>
                            
                            ${approvalHtml}
                            ${runningProgressHtml}
                            ${errorHtml}
                            ${finalResponseHtml}
                            ${filesHtml}
                            ${activityLogHtml}
                        </div>
                    `;

                    // Bind dashboard click & link listeners
                    this._bindDashboardEvents(bodyContentEl);
                }
            }
        }

        // Re-bind approval buttons for pending tasks (both general and detail view elements)
        this.tasks.forEach(task => {
            const pendingApprovals = (task.messages || [])
                .map((msg, idx) => ({ msg, idx }))
                .filter(({ msg }) => msg.type === 'approval' && !msg.resolved);
            
            pendingApprovals.forEach(({ msg, idx }) => {
                const socket = this.sockets.get(task.id);
                if (socket) {
                    this._showApprovalUI(task.id, idx, msg.data, socket);
                }
            });
        });
    }

    _bindNewTaskFormEvents() {
        const submitBtn = this.element.querySelector('#tnp-submit-btn');
        const promptInput = this.element.querySelector('#tnp-prompt-input');
        
        submitBtn?.addEventListener('click', () => this._submitTask());
        promptInput?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this._submitTask();
            }
        });
    }

    _bindDashboardEvents(container) {
        if (!container) return;

        // 1. Bind Open buttons
        container.querySelectorAll('.tnp-btn-file-open').forEach(btn => {
            btn.onclick = () => {
                const path = btn.dataset.path;
                if (window.app && window.app.openFile) {
                    window.app.openFile(path);
                }
            };
        });

        // 2. Bind Diff buttons
        container.querySelectorAll('.tnp-btn-file-diff').forEach(btn => {
            btn.onclick = () => {
                const taskId = btn.dataset.taskId;
                const fileIdx = parseInt(btn.dataset.fileIdx, 10);
                const task = this.tasks.find(t => t.id === taskId);
                if (task && task.modifiedFiles && task.modifiedFiles[fileIdx]) {
                    let f = task.modifiedFiles[fileIdx];
                    if (typeof f === 'string') f = { path: f };
                    const openDiff = () => {
                        if (window.app && window.app.openDiffEditor) {
                            window.app.openDiffEditor(f.original, f.current, f.path);
                        }
                    };
                    // History tasks may have a file LIST but not the rich
                    // original/current content (older persisted history, or the
                    // list came from `file_modified` events). Fetch the task
                    // detail on demand — GET /tasks/:id now returns the
                    // persisted `modified_files` — and retry with the real diff.
                    if ((f.original === undefined || f.current === undefined) && !this._fetchingTaskDiff[taskId]) {
                        this._fetchingTaskDiff[taskId] = true;
                        this._fetchTaskDetail(taskId)
                            .then(detail => {
                                this._fetchingTaskDiff[taskId] = false;
                                // Match by PATH, not index: history `file_modified`
                                // entries ({path} only) and the persisted
                                // `modified_files` array can be in a different order.
                                let rich = null;
                                if (detail && Array.isArray(detail.modified_files) && f.path) {
                                    rich = detail.modified_files.find(m => m.path === f.path) || null;
                                }
                                if (rich) {
                                    if (window.app && window.app.openDiffEditor) {
                                        window.app.openDiffEditor(rich.original ?? null, rich.current ?? '', rich.path || f.path);
                                    }
                                    return;
                                }
                                // Fall back to whatever we have (e.g. created-only files).
                                if (f.current !== undefined) openDiff();
                            })
                            .catch(() => { this._fetchingTaskDiff[taskId] = false; if (f.current !== undefined) openDiff(); });
                    } else {
                        openDiff();
                    }
                }
            };
        });

        // 3. Bind local file links inside report content
        container.querySelectorAll('.tnp-markdown-body a').forEach(a => {
            a.onclick = (e) => {
                const href = a.getAttribute('href');
                if (href) {
                    const isHttp = href.startsWith('http://') || href.startsWith('https://');
                    if (!isHttp) {
                        e.preventDefault();
                        let targetPath = href;
                        if (href.startsWith('file:///')) {
                            targetPath = href.substring(8);
                        }
                        if (window.app && window.app.openFile) {
                            window.app.openFile(targetPath);
                        }
                    }
                }
            };
        });
    }

    toggle() {
        this.isVisible = !this.isVisible;
        this.element.classList.toggle('visible', this.isVisible);
        if (this.isVisible) {
            this._checkConnection();
        }
    }

    _escapeHtml(str) {
        if (!str) return '';
        return str.replace(/&/g, "&amp;")
                  .replace(/</g, "&lt;")
                  .replace(/>/g, "&gt;")
                  .replace(/"/g, "&quot;");
    }

    destroy() {
        for (const socket of this.sockets.values()) {
            socket.close();
        }
        this.sockets.clear();
        if (this._onProjectSwitched) {
            window.removeEventListener('app:project-switched', this._onProjectSwitched);
        }
        this.element?.remove();
    }
}
