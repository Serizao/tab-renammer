import type { Caido } from "@caido/sdk-frontend";
import { createApp, h, ref, onMounted, onUnmounted, inject } from "vue";

export type CaidoSDK = Caido;

// Storage interface
interface PluginStorage {
  knownSessions: string[];
  customNamingFunction: string;
  pollingInterval: number;
}

// Simple Vue component for the tab renamer
const TabRenamerComponent = {
  name: 'TabRenamer',
  setup() {
    // Get SDK from injection
    const sdkInstance = inject<CaidoSDK>('sdk');
    
    // Reactive state
    const isPolling = ref(false);
    const logsEnabled = ref(true);
    const sessionsCount = ref(0);
    const knownCount = ref(0);
    const newCount = ref(0);
    const activityLogs = ref<string[]>([]);
    const namingFunction = ref('');
    const pollingInterval = ref(3000); // Polling interval in milliseconds

    // Polling interval
    let pollingIntervalId: ReturnType<typeof setInterval> | null = null;

    // Storage functions using Caido storage API
    async function getStorage(): Promise<PluginStorage> {
      try {
        if (!sdkInstance) return { knownSessions: [], customNamingFunction: '', pollingInterval: 3000 };
        const stored = await sdkInstance.storage.get();
        if (stored && typeof stored === 'object' && stored !== null && !Array.isArray(stored)) {
          const storageObj = stored as Record<string, any>;
          return {
            knownSessions: Array.isArray(storageObj.knownSessions) ? storageObj.knownSessions : [],
            customNamingFunction: typeof storageObj.customNamingFunction === 'string' ? storageObj.customNamingFunction : '',
            pollingInterval: typeof storageObj.pollingInterval === 'number' ? storageObj.pollingInterval : 3000
          };
        }
      } catch (error) {
        console.error('Error reading storage:', error);
      }
      return { knownSessions: [], customNamingFunction: '', pollingInterval: 3000 };
    }

    async function saveStorage(storage: PluginStorage) {
      try {
        if (!sdkInstance) return;
        await sdkInstance.storage.set(storage);
      } catch (error) {
        console.error('Error writing storage:', error);
      }
    }

    async function getKnownSessions(): Promise<Set<string>> {
      const storage = await getStorage();
      return new Set(storage.knownSessions);
    }

    async function saveKnownSessions(sessions: Set<string>) {
      const storage = await getStorage();
      storage.knownSessions = Array.from(sessions);
      await saveStorage(storage);
    }

    async function clearKnownSessions() {
      const storage = await getStorage();
      storage.knownSessions = [];
      await saveStorage(storage);
    }

    async function getCustomNamingFunction(): Promise<string> {
      const storage = await getStorage();
      return storage.customNamingFunction;
    }

    async function saveCustomNamingFunction(functionCode: string) {
      const storage = await getStorage();
      storage.customNamingFunction = functionCode;
      await saveStorage(storage);
    }

    async function getPollingInterval(): Promise<number> {
      const storage = await getStorage();
      return storage.pollingInterval;
    }

    async function savePollingInterval(interval: number) {
      const storage = await getStorage();
      storage.pollingInterval = interval;
      await saveStorage(storage);
    }

    function getDefaultNamingFunction(): string {
      return `// Default naming function
// Available variables: method, path, host
// Must return a string

const cleanPath = path.replace(/[?#].*$/, '').replace(/[^a-zA-Z0-9\/\\-\\_\\.]/g, '');
const maxLength = 30;
let tabName = \`\${method} \${cleanPath}\`;

if (tabName.length > maxLength) {
  const truncated = cleanPath.substring(0, maxLength - method.length - 4) + '...';
  tabName = \`\${method} \${truncated}\`;
}

return tabName;`;
    }

    // Utility functions
    function addLog(message: string) {
      if (!logsEnabled.value) return;
      
      const timestamp = new Date().toLocaleTimeString();
      const logEntry = `[${timestamp}] ${message}`;
      
      activityLogs.value.unshift(logEntry);
      
      // Keep only last 50 logs
      if (activityLogs.value.length > 50) {
        activityLogs.value = activityLogs.value.slice(0, 50);
      }
    }

    function generateTabName(method: string, path: string, host?: string): string {
      try {
        // Try to use custom function
        const customFunction = namingFunction.value;
        
        if (customFunction.trim()) {
          // Create function from custom code
          const userFunction = new Function('method', 'path', 'host', customFunction);
          const result = userFunction(method, path, host || '');
          
          if (typeof result === 'string' && result.trim()) {
            return result.trim();
          }
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        addLog(`⚠️ Custom function error: ${errorMessage}`);
        addLog('🔄 Using default function');
      }
      
      // Default function in case of error or no custom function
      const cleanPath = path.replace(/[?#].*$/, '').replace(/[^a-zA-Z0-9\/\-\_\.]/g, '');
      const maxLength = 30;
      let tabName = `${method} ${cleanPath}`;
      
      if (tabName.length > maxLength) {
        const truncated = cleanPath.substring(0, maxLength - method.length - 4) + '...';
        tabName = `${method} ${truncated}`;
      }
      
      return tabName;
    }

    function parseRawRequest(raw: string) {
      try {
        if (!raw || typeof raw !== 'string') {
          return null;
        }
        
        // Normalize line breaks
        const normalizedRaw = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        const lines = normalizedRaw.split('\n');
        
        if (lines.length === 0) {
          return null;
        }
        
        // Find request line (first non-empty line)
        let requestLine = '';
        for (const line of lines) {
          if (line.trim()) {
            requestLine = line.trim();
            break;
          }
        }
        
        if (!requestLine) {
          return null;
        }
        
        // Parse request line: METHOD PATH HTTP/VERSION
        const parts = requestLine.split(/\s+/);
        if (parts.length < 2) {
          return null;
        }
        
        const method = parts[0];
        const path = parts[1];
        
        // Look for Host header
        let host = '';
        for (const line of lines) {
          const trimmedLine = line.trim();
          if (trimmedLine.toLowerCase().startsWith('host:')) {
            host = trimmedLine.substring(5).trim();
            break;
          }
        }
        
        // Validate results
        if (!method || !path) {
          return null;
        }
        
        return { method, path, host };
        
      } catch (error) {
        console.error('Error parseRawRequest:', error);
        return null;
      }
    }

    async function getSessionDetails(sessionId: string) {
      try {
        if (!sdkInstance) return null;
        
        const auth = JSON.parse(localStorage.getItem("CAIDO_AUTHENTICATION") || "{}");
        const accessToken = auth.accessToken;
        
        if (!accessToken) {
          throw new Error("Token manquant");
        }
        try {
          const response = await fetch('/graphql', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${accessToken}`
            },
            body: JSON.stringify({
              query: 'query replaySession($id:String!){replaySession(id:$id){activeEntry{createdAt raw session{id name}}}}',
              variables: { id: sessionId },
              operationName: 'replaySession',
            }),
          });
          
          if (response.ok) {
            const data = await response.json();
            console.log(data);
            return data.data?.replaySession?.activeEntry;
          }
        } catch (error) {
          console.log('GraphQL request failed, trying alternative approach');
        }
        
        // If GraphQL fails, try to get basic session info
        // This is a fallback approach
        return {
          session: { name: `Session ${sessionId}` },
          raw: btoa('GET /api/fallback HTTP/1.1\nHost: localhost\n\n')
        };
        
      } catch (error) {
        console.error('Error getSessionDetails:', error);
        return null;
      }
    }

    async function checkAndRenameReplayTabs() {
      try {
        if (!sdkInstance) {
          addLog('❌ SDK not available');
          return;
        }

        addLog('🔍 Checking sessions...');
        
        // Get real sessions from Caido
        const sessions = await sdkInstance.replay.getSessions();
        
        if (!sessions || sessions.length === 0) {
          addLog('ℹ️ No sessions found');
          updateCounts(0, 0, 0);
          return;
        }
        
        const knownSessions = await getKnownSessions();
        const currentSessionIds = new Set(sessions.map(s => s.id));
        
        // Filter out sessions that are already known (already processed)
        const newSessions = sessions.filter(session => !knownSessions.has(session.id));
        
        addLog(`📊 ${sessions.length} total, ${knownSessions.size} known, ${newSessions.length} new`);
        updateCounts(sessions.length, knownSessions.size, newSessions.length);
        
        if (newSessions.length === 0) {
          addLog('ℹ️ No new sessions');
          await saveKnownSessions(currentSessionIds);
          return;
        }
        
        let renamedCount = 0;
        
        for (const session of newSessions) {
          try {
            addLog(`🆕 Processing session ${session.id}...`);
            
            const entry = await getSessionDetails(session.id);
            if (!entry || !entry.raw) {
              addLog(`⚠️ No details for ${session.id}`);
              continue;
            }
            
            const currentName = entry.session?.name || session.name;
            const requestInfo = parseRawRequest(atob(entry.raw));
            
            if (!requestInfo) {
              addLog(`⚠️ Cannot parse ${session.id}`);
              continue;
            }
            
            const newName = generateTabName(requestInfo.method, requestInfo.path);
            
            // Check if the session is already correctly named
            if (currentName === newName) {
              addLog(`✅ ${session.id} already correctly named`);
              continue;
            }
            
            // Actually rename the session using Caido API
            await sdkInstance.replay.renameSession(session.id, newName);
            
            addLog(`🏷️ ${session.id} → "${newName}"`);
            addLog(`   📍 ${requestInfo.method} ${requestInfo.host}${requestInfo.path}`);
            
            renamedCount++;
            
            // Small delay to avoid overwhelming the API
            await new Promise(resolve => setTimeout(resolve, 100));
            
          } catch (error) {
            addLog(`❌ Error ${session.id}: ${error}`);
          }
        }
        
        // Save all current sessions as known (including the ones we just processed)
        await saveKnownSessions(currentSessionIds);
        addLog(`💾 ${currentSessionIds.size} sessions saved as known`);
        
        if (renamedCount > 0) {
          addLog(`🎉 ${renamedCount} sessions renamed`);
        }
        
        const finalKnown = await getKnownSessions();
        updateCounts(sessions.length, finalKnown.size, 0);
        
      } catch (error) {
        addLog(`❌ Error: ${error}`);
        console.error('Error checkAndRenameReplayTabs:', error);
      }
    }

    function updateCounts(total: number, known: number, newCountValue: number) {
      sessionsCount.value = total;
      knownCount.value = known;
      newCount.value = newCountValue;
    }

    function startPolling() {
      if (pollingIntervalId) {
        clearInterval(pollingIntervalId);
      }
      
      isPolling.value = true;
      checkAndRenameReplayTabs();
      
      pollingIntervalId = setInterval(() => {
        checkAndRenameReplayTabs();
      }, pollingInterval.value);
      
      addLog(`🔄 Polling started (${pollingInterval.value}ms interval)`);
    }

    function stopPolling() {
      if (pollingIntervalId) {
        clearInterval(pollingIntervalId);
        pollingIntervalId = null;
      }
      
      isPolling.value = false;
      addLog('⏹️ Polling stopped');
    }

    // Event handlers
    const onStartClick = () => {
      if (!isPolling.value) {
        startPolling();
      } else {
        stopPolling();
      }
    };

    const onTestClick = () => {
      checkAndRenameReplayTabs();
    };

    const onResetClick = async () => {
      await clearKnownSessions();
      addLog('🔄 Storage sessions cleared');
      updateCounts(0, 0, 0);
    };

    const onToggleLogsClick = () => {
      logsEnabled.value = !logsEnabled.value;
      addLog(`📋 Logs ${logsEnabled.value ? 'enabled' : 'disabled'}`);
    };

    const onSaveFunctionClick = async () => {
      await saveCustomNamingFunction(namingFunction.value);
      addLog('💾 Naming function saved');
    };

    const onResetFunctionClick = () => {
      namingFunction.value = getDefaultNamingFunction();
      saveCustomNamingFunction(''); // Clear storage
      addLog('🔄 Default function restored');
    };

    const onPollingIntervalChange = (e: Event) => {
      const value = parseInt((e.target as HTMLInputElement).value);
      pollingInterval.value = value;
      addLog(`⏱️ Polling interval changed to ${value}ms`);
      
      // Save to storage
      savePollingInterval(value);
      
      // Restart polling with new interval if currently active
      if (isPolling.value) {
        stopPolling();
        startPolling();
      }
    };

    // Lifecycle
    onMounted(async () => {
      console.log('🎨 Plugin Replay Tab Renamer - Frontend started');
      
      // Load custom naming function
      namingFunction.value = await getCustomNamingFunction() || getDefaultNamingFunction();
      
      // Load polling interval from storage
      const storedInterval = await getPollingInterval();
      pollingInterval.value = storedInterval;
      
      // Initialize
      const knownSessions = await getKnownSessions();
      addLog(`🔄 ${knownSessions.size} sessions in memory`);
      addLog(`⏱️ Polling interval loaded: ${storedInterval}ms`);
      updateCounts(0, knownSessions.size, 0);
      
      // Start polling after 2 seconds
      setTimeout(() => {
        startPolling();
      }, 2000);
      
      console.log('✅ Plugin initialized');
    });

    onUnmounted(() => {
      if (pollingIntervalId) {
        clearInterval(pollingIntervalId);
      }
    });

    return () => h('div', { class: 'p-5 font-sans', style: { backgroundColor: 'var(--p-surface-900)', color: 'var(--p-surface-0)' } }, [
      h('h1', { class: 'text-2xl font-bold mb-6', style: { color: 'var(--p-surface-0)' } }, '🏷️ Replay Tab Auto-Renamer'),
      
      // Three column layout using flexbox
      h('div', { class: 'flex gap-6 mb-6' }, [
        // Status Card (Left)
        h('div', { 
          class: 'flex-1 p-4 rounded-lg shadow-sm border',
          style: { 
            backgroundColor: 'var(--p-surface-800)',
            borderColor: 'var(--p-surface-700)',
            color: 'var(--p-surface-0)'
          }
        }, [
          h('h3', { 
            class: 'text-lg font-semibold mb-3',
            style: { color: 'var(--p-primary-color)' }
          }, '📊 Status'),
          h('div', { 
            class: 'space-y-2',
            style: { color: 'var(--p-surface-0)' }
          }, [
            h('p', `Active polling: ${isPolling.value ? 'Yes' : 'No'}`),
            h('p', `Sessions found: ${sessionsCount.value}`),
            h('p', `Known sessions: ${knownCount.value}`),
            h('p', `New sessions: ${newCount.value}`),
            h('p', `Logs enabled: ${logsEnabled.value ? 'Yes' : 'No'}`)
          ])
        ]),
        
        // Logs Card (Center)
        h('div', { 
          class: 'flex-1 p-4 rounded-lg shadow-sm border',
          style: { 
            backgroundColor: 'var(--p-surface-800)',
            borderColor: 'var(--p-surface-700)',
            color: 'var(--p-surface-0)'
          }
        }, [
          h('h3', { 
            class: 'text-lg font-semibold mb-3',
            style: { color: 'var(--p-surface-0)' }
          }, '📝 Activity Logs'),
          h('div', {
            class: 'p-3 rounded border font-mono text-xs',
            style: { 
              display: logsEnabled.value ? 'block' : 'none',
              height: '200px',
              overflowY: 'auto',
              scrollbarWidth: 'thin',
              scrollbarColor: 'var(--p-surface-600) var(--p-surface-800)',
              backgroundColor: 'var(--p-surface-900)',
              color: 'var(--p-success-400)',
              borderColor: 'var(--p-surface-700)'
            }
          }, [
            activityLogs.value.length === 0 
              ? h('div', { style: { color: 'var(--p-surface-400)', fontStyle: 'italic' } }, 'Waiting...')
              : activityLogs.value.map(log => h('div', { 
                class: 'mb-1 break-words',
                style: { color: 'var(--p-success-400)' }
              }, log))
          ])
        ]),
        
        // Polling Configuration Card (Right)
        h('div', { 
          class: 'flex-1 p-4 rounded-lg shadow-sm border',
          style: { 
            backgroundColor: 'var(--p-surface-800)',
            borderColor: 'var(--p-surface-700)',
            color: 'var(--p-surface-0)'
          }
        }, [
          h('h3', { 
            class: 'text-lg font-semibold mb-3',
            style: { color: 'var(--p-success-color)' }
          }, '⏱️ Polling Configuration'),
          h('div', { class: 'space-y-3' }, [
            h('div', { class: 'flex items-center justify-between' }, [
              h('label', { 
                class: 'text-sm font-medium',
                style: { color: 'var(--p-surface-0)' }
              }, 'Polling Interval:'),
              h('span', { 
                class: 'text-sm',
                style: { color: 'var(--p-surface-300)' }
              }, `${pollingInterval.value}ms`)
            ]),
            h('input', {
              type: 'range',
              min: '1000',
              max: '10000',
              step: '500',
              value: pollingInterval.value,
              onChange: onPollingIntervalChange,
              class: 'w-full h-2 rounded-lg appearance-none cursor-pointer',
              style: { backgroundColor: 'var(--p-surface-600)' }
            }),
            h('div', { 
              class: 'flex justify-between text-xs',
              style: { color: 'var(--p-surface-400)' }
            }, [
              h('span', '1s'),
              h('span', '5s'),
              h('span', '10s')
            ])
          ])
        ])
      ]),
      
      // Configuration Card (Full width)
      h('div', { 
        class: 'mb-6 p-4 rounded-lg shadow-sm border',
        style: { 
          backgroundColor: 'var(--p-surface-800)',
          borderColor: 'var(--p-surface-700)',
          color: 'var(--p-surface-0)'
        }
      }, [
        h('h3', { 
          class: 'text-lg font-semibold mb-3',
          style: { color: 'var(--p-secondary-color)' }
        }, '⚙️ Renaming Configuration'),
        h('p', { 
          class: 'mb-3',
          style: { color: 'var(--p-surface-0)' }
        }, 'Customize the tab name generation function:'),
        h('textarea', {
          value: namingFunction.value,
          onInput: (e: Event) => {
            namingFunction.value = (e.target as HTMLTextAreaElement).value;
          },
          class: 'w-full font-mono text-sm border rounded p-3',
          style: { 
            height: '200px',
            backgroundColor: 'var(--p-surface-900)',
            color: 'var(--p-surface-0)',
            borderColor: 'var(--p-surface-600)'
          },
          placeholder: 'Enter custom naming function...'
        })
      ]),
      
      // Main Buttons
      h('div', { class: 'flex gap-3 mb-4' }, [
        h('button', {
          onClick: onStartClick,
          class: 'px-4 py-2 rounded font-medium',
          style: {
            backgroundColor: isPolling.value ? 'var(--p-danger-color)' : 'var(--p-primary-color)',
            color: 'var(--p-primary-contrast-color)',
            border: 'none',
            cursor: 'pointer'
          }
        }, isPolling.value ? 'Stop' : 'Start'),
        h('button', {
          onClick: onTestClick,
          class: 'px-4 py-2 rounded font-medium',
          style: {
            backgroundColor: 'var(--p-surface-600)',
            color: 'var(--p-surface-0)',
            border: 'none',
            cursor: 'pointer'
          }
        }, 'Test'),
        h('button', {
          onClick: onResetClick,
          class: 'px-4 py-2 rounded border font-medium',
          style: {
            borderColor: 'var(--p-surface-600)',
            color: 'var(--p-surface-0)',
            backgroundColor: 'transparent',
            cursor: 'pointer'
          }
        }, 'Reset Sessions'),
        h('button', {
          onClick: onToggleLogsClick,
          class: 'px-4 py-2 rounded border font-medium',
          style: {
            borderColor: 'var(--p-surface-600)',
            color: 'var(--p-surface-0)',
            backgroundColor: 'transparent',
            cursor: 'pointer'
          }
        }, logsEnabled.value ? 'Hide Logs' : 'Show Logs')
      ]),
      
      // Configuration Buttons
      h('div', { class: 'flex gap-3' }, [
        h('button', {
          onClick: onSaveFunctionClick,
          class: 'px-4 py-2 rounded font-medium',
          style: {
            backgroundColor: 'var(--p-primary-700)',
            color: 'var(--p-surface-0)',
            border: 'none',
            cursor: 'pointer'
          }
        }, 'Save Function'),
        h('button', {
          onClick: onResetFunctionClick,
          class: 'px-4 py-2 rounded border font-medium',
          style: {
            borderColor: 'var(--p-surface-600)',
            color: 'var(--p-surface-0)',
            backgroundColor: 'transparent',
            cursor: 'pointer'
          }
        }, 'Default Function')
      ])
    ]);
  }
};

export function init(sdk: CaidoSDK) {
  console.log("🎨 Plugin Replay Tab Renamer - Frontend started");
  
  // Create a container element
  const container = document.createElement("div");
  
  // Create and mount the Vue app with SDK access
  const app = createApp(TabRenamerComponent);
  
  // Provide SDK to the component
  app.provide('sdk', sdk);
  
  app.mount(container);
  
  // Add the page to navigation with the mounted Vue component
  sdk.navigation.addPage("/replay-tab-renamer", { body: container });
  
  // Register sidebar item
  sdk.sidebar.registerItem("Replay Tabs", "/replay-tab-renamer", {
    icon: "fas fa-tag"
  });
  
  console.log("✅ Plugin initialized");
}