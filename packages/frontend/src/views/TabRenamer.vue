<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import Button from 'primevue/button';
import Card from 'primevue/card';
import Textarea from 'primevue/textarea';
import { useSDK } from '../plugins/sdk';

const sdk = useSDK();

// Reactive state
const isPolling = ref(false);
const logsEnabled = ref(true);
const sessionsCount = ref(0);
const knownCount = ref(0);
const newCount = ref(0);
const activityLogs = ref<string[]>([]);
const namingFunction = ref('');

// Storage interface
interface PluginStorage {
  knownSessions: string[];
  customNamingFunction: string;
}

// Polling interval
let pollingInterval: ReturnType<typeof setInterval> | null = null;

// Storage functions using Caido storage API
async function getStorage(): Promise<PluginStorage> {
  try {
    const stored = await sdk.storage.get();
    if (stored && typeof stored === 'object' && stored !== null) {
      return {
        knownSessions: Array.isArray(stored.knownSessions) ? stored.knownSessions : [],
        customNamingFunction: typeof stored.customNamingFunction === 'string' ? stored.customNamingFunction : ''
      };
    }
  } catch (error) {
    console.error('Error reading storage:', error);
  }
  return { knownSessions: [], customNamingFunction: '' };
}

async function saveStorage(storage: PluginStorage) {
  try {
    await sdk.storage.set(storage);
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

// Custom naming function functions
async function getCustomNamingFunction(): Promise<string> {
  const storage = await getStorage();
  return storage.customNamingFunction;
}

async function saveCustomNamingFunction(functionCode: string) {
  const storage = await getStorage();
  storage.customNamingFunction = functionCode;
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

async function getSessionDetails(sessionId: string) {
  try {
    // For now, we'll use a simple approach without authentication
    // In a real implementation, you might need to handle authentication differently
    const response = await fetch('/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: 'query replaySession($id:String!){replaySession(id:$id){activeEntry{createdAt raw session{id name}}}}',
        variables: { id: sessionId },
        operationName: 'replaySession',
      }),
    });
    
    const data = await response.json();
    return data.data?.replaySession?.activeEntry;
  } catch (error) {
    console.error('Error getSessionDetails:', error);
    return null;
  }
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

async function checkAndRenameReplayTabs() {
  try {
    addLog('🔍 Checking sessions...');
    
    const sessions = await sdk.replay.getSessions();
    
    if (!sessions || sessions.length === 0) {
      addLog('ℹ️ No sessions found');
      updateCounts(0, 0, 0);
      return;
    }
    
    const knownSessions = await getKnownSessions();
    const currentSessionIds = new Set(sessions.map(s => s.id));
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
        
        if (currentName === newName) {
          addLog(`✅ ${session.id} already correct`);
          continue;
        }
        
        await sdk.replay.renameSession(session.id, newName);
        
        addLog(`🏷️ ${session.id} → "${newName}"`);
        addLog(`   📍 ${requestInfo.method} ${requestInfo.host}${requestInfo.path}`);
        
        renamedCount++;
        
        await new Promise(resolve => setTimeout(resolve, 100));
        
      } catch (error) {
        addLog(`❌ Error ${session.id}: ${error}`);
      }
    }
    
    await saveKnownSessions(currentSessionIds);
    addLog(`💾 ${currentSessionIds.size} sessions saved`);
    
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
  if (pollingInterval) {
    clearInterval(pollingInterval);
  }
  
  isPolling.value = true;
  checkAndRenameReplayTabs();
  
  pollingInterval = setInterval(() => {
    checkAndRenameReplayTabs();
  }, 3000);
  
  addLog('🔄 Polling started');
}

function stopPolling() {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
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

// Lifecycle
onMounted(async () => {
  console.log('🎨 Plugin Replay Tab Renamer - Frontend started');
  
  // Load custom naming function
  namingFunction.value = await getCustomNamingFunction() || getDefaultNamingFunction();
  
  // Initialize
  const knownSessions = await getKnownSessions();
  addLog(`🔄 ${knownSessions.size} sessions in memory`);
  updateCounts(0, knownSessions.size, 0);
  
  // Start polling after 2 seconds
  setTimeout(() => {
    startPolling();
  }, 2000);
  
  console.log('✅ Plugin initialized');
});

onUnmounted(() => {
  if (pollingInterval) {
    clearInterval(pollingInterval);
  }
});
</script>

<template>
  <div class="p-5 font-sans">
    <h1 class="text-2xl font-bold mb-5">🏷️ Replay Tab Auto-Renamer</h1>
    
    <!-- Status Card -->
    <Card class="mb-5">
      <template #title>
        <h3 class="text-lg font-semibold">📊 Status</h3>
      </template>
      <template #content>
        <div class="space-y-2">
          <p>Active polling: <span class="font-semibold">{{ isPolling ? 'Yes' : 'No' }}</span></p>
          <p>Sessions found: <span class="font-semibold">{{ sessionsCount }}</span></p>
          <p>Known sessions: <span class="font-semibold">{{ knownCount }}</span></p>
          <p>New sessions: <span class="font-semibold">{{ newCount }}</span></p>
          <p>Logs enabled: <span class="font-semibold">{{ logsEnabled ? 'Yes' : 'No' }}</span></p>
        </div>
      </template>
    </Card>
    
    <!-- Configuration Card -->
    <Card class="mb-5">
      <template #title>
        <h3 class="text-lg font-semibold">⚙️ Renaming Configuration</h3>
      </template>
      <template #content>
        <p class="mb-3">Customize the tab name generation function:</p>
        <Textarea
          v-model="namingFunction"
          :rows="30"
          :style="heigth:200px"
          class="w-full font-mono text-sm"
          placeholder="Enter custom naming function..."
        />
      </template>
    </Card>
    
    <!-- Logs Card -->
    <Card class="mb-5">
      <template #title>
        <h3 class="text-lg font-semibold">📝 Activity Logs</h3>
      </template>
      <template #content>
        <div
          v-show="logsEnabled"
          class="bg-gray-900 text-green-400 p-3 rounded border border-gray-700 max-h-48 overflow-y-auto font-mono text-xs"
        >
          <div v-if="activityLogs.length === 0" class="text-gray-500 italic">
            Waiting...
          </div>
          <div v-else>
            <div
              v-for="log in activityLogs"
              :key="log"
              class="mb-1 text-green-400"
            >
              {{ log }}
            </div>
          </div>
        </div>
      </template>
    </Card>
    
    <!-- Main Buttons -->
    <div class="flex gap-2 mb-3">
      <Button
        :label="isPolling ? 'Stop' : 'Start'"
        :variant="isPolling ? 'outline' : 'primary'"
        @click="onStartClick"
      />
      <Button
        label="Test"
        variant="secondary"
        @click="onTestClick"
      />
      <Button
        label="Reset Sessions"
        variant="outline"
        @click="onResetClick"
      />
      <Button
        :label="logsEnabled ? 'Hide Logs' : 'Show Logs'"
        variant="outline"
        @click="onToggleLogsClick"
      />
    </div>
    
    <!-- Configuration Buttons -->
    <div class="flex gap-2">
      <Button
        label="Save Function"
        variant="secondary"
        @click="onSaveFunctionClick"
      />
      <Button
        label="Default Function"
        variant="outline"
        @click="onResetFunctionClick"
      />
    </div>
  </div>
</template> 