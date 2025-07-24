import type { Caido } from "@caido/sdk-frontend";
import type { API } from "../../backend/src/index";

export type CaidoSDK = Caido<API>;

let pollingInterval: NodeJS.Timeout | null = null;
let isPolling = false;
let logsEnabled = true;
const STORAGE_KEY = 'caido-replay-tab-renamer-sessions';
const NAMING_FUNCTION_KEY = 'caido-replay-tab-renamer-naming-function';

// Fonctions localStorage
function getKnownSessions(): Set<string> {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      return new Set(JSON.parse(stored));
    }
  } catch (error) {
    console.error("Erreur localStorage read:", error);
  }
  return new Set();
}

function saveKnownSessions(sessions: Set<string>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(sessions)));
  } catch (error) {
    console.error("Erreur localStorage write:", error);
  }
}

function clearKnownSessions() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (error) {
    console.error("Erreur localStorage clear:", error);
  }
}

// Fonctions pour la fonction de renommage personnalisée
function getCustomNamingFunction(): string {
  try {
    return localStorage.getItem(NAMING_FUNCTION_KEY) || '';
  } catch (error) {
    console.error("Erreur lecture fonction naming:", error);
    return '';
  }
}

function saveCustomNamingFunction(functionCode: string) {
  try {
    localStorage.setItem(NAMING_FUNCTION_KEY, functionCode);
  } catch (error) {
    console.error("Erreur sauvegarde fonction naming:", error);
  }
}

function getDefaultNamingFunction(): string {
  return `// Fonction de renommage par défaut
// Variables disponibles: method, path, host
// Doit retourner une string

const cleanPath = path.replace(/[?#].*$/, '').replace(/[^a-zA-Z0-9\/\\-\\_\\.]/g, '');
const maxLength = 30;
let tabName = \`\${method} \${cleanPath}\`;

if (tabName.length > maxLength) {
  const truncated = cleanPath.substring(0, maxLength - method.length - 4) + '...';
  tabName = \`\${method} \${truncated}\`;
}

return tabName;`;
}

export function init(sdk: CaidoSDK) {
  console.log("🎨 Plugin Replay Tab Renamer - Frontend démarré");
  
  // Interface
  const container = document.createElement("div");
  container.style.padding = "20px";
  container.style.fontFamily = "Arial, sans-serif";
  
  const title = document.createElement("h1");
  title.textContent = "🏷️ Replay Tab Auto-Renamer";
  title.style.marginBottom = "20px";
  
  const statusDiv = document.createElement("div");
  statusDiv.style.backgroundColor = "#f0f8f0";
  statusDiv.style.color = "black";
  statusDiv.style.padding = "15px";
  statusDiv.style.borderRadius = "8px";
  statusDiv.style.marginBottom = "20px";
  statusDiv.innerHTML = `
    <h3>📊 Statut :</h3>
    <p>Polling actif : <span id="polling-status">Non</span></p>
    <p>Sessions trouvées : <span id="sessions-count">0</span></p>
    <p>Sessions connues : <span id="known-count">0</span></p>
    <p>Nouvelles sessions : <span id="new-count">0</span></p>
    <p>Logs activés : <span id="logs-status">Oui</span></p>
  `;
  
  // Configuration du renommage
  const configDiv = document.createElement("div");
  configDiv.style.backgroundColor = "#f8f8f8";
  configDiv.style.padding = "15px";
 
  configDiv.style.borderRadius = "8px";
  configDiv.style.marginBottom = "20px";
  configDiv.innerHTML = `
    <h3>⚙️ Configuration de renommage :</h3>
    <p>Personnalisez la fonction de génération des noms d'onglets :</p>
  `;
  
  const functionTextarea = document.createElement("textarea");
  functionTextarea.id = "naming-function";
  functionTextarea.style.width = "100%";
  functionTextarea.style.height = "200px";
  functionTextarea.style.fontFamily = "monospace";
  functionTextarea.style.color = "black";
  functionTextarea.style.fontSize = "12px";
  functionTextarea.style.border = "1px solid #ccc";
  functionTextarea.style.borderRadius = "4px";
  functionTextarea.style.padding = "10px";
  functionTextarea.value = getCustomNamingFunction() || getDefaultNamingFunction();
  
  configDiv.appendChild(functionTextarea);
  
  const logsDiv = document.createElement("div");
  logsDiv.innerHTML = `
    <h3>📝 Logs :</h3>
    <div id="activity-logs" style="background: #1a1a1a; color: #00ff00; padding: 10px; border-radius: 4px; max-height: 200px; overflow-y: auto; font-family: monospace; font-size: 12px; border: 1px solid #333;">
      <em style="color: #888;">En attente...</em>
    </div>
  `;
  
  // Boutons
  const startButton = sdk.ui.button({
    variant: "primary",
    label: "Démarrer"
  });
  
  const testButton = sdk.ui.button({
    variant: "secondary", 
    label: "Test"
  });
  
  const resetButton = sdk.ui.button({
    variant: "outline",
    label: "Reset Sessions"
  });
  
  const toggleLogsButton = sdk.ui.button({
    variant: "outline",
    label: "Masquer Logs"
  });
  
  const saveFunctionButton = sdk.ui.button({
    variant: "secondary",
    label: "Sauvegarder Fonction"
  });
  
  const resetFunctionButton = sdk.ui.button({
    variant: "outline",
    label: "Fonction par défaut"
  });
  
  // Events
  startButton.addEventListener("click", () => {
    if (!isPolling) {
      startPolling();
      startButton.textContent = "Arrêter";
      updateStatus("Oui");
    } else {
      stopPolling();
      startButton.textContent = "Démarrer";
      updateStatus("Non");
    }
  });
  
  testButton.addEventListener("click", () => {
    checkAndRenameReplayTabs();
  });
  
  resetButton.addEventListener("click", () => {
    clearKnownSessions();
    addLog("🔄 LocalStorage sessions vidé");
    updateCounts(0, 0, 0);
  });
  
  toggleLogsButton.addEventListener("click", () => {
    logsEnabled = !logsEnabled;
    const logsContainer = document.getElementById("activity-logs");
    if (logsContainer) {
      logsContainer.style.display = logsEnabled ? "block" : "none";
    }
    toggleLogsButton.textContent = logsEnabled ? "Masquer Logs" : "Afficher Logs";
    updateLogsStatus(logsEnabled ? "Oui" : "Non");
    addLog(`📋 Logs ${logsEnabled ? 'activés' : 'désactivés'}`);
  });
  
  saveFunctionButton.addEventListener("click", () => {
    const textarea = document.getElementById("naming-function") as HTMLTextAreaElement;
    if (textarea) {
      saveCustomNamingFunction(textarea.value);
      addLog("💾 Fonction de renommage sauvegardée");
    }
  });
  
  resetFunctionButton.addEventListener("click", () => {
    const textarea = document.getElementById("naming-function") as HTMLTextAreaElement;
    if (textarea) {
      textarea.value = getDefaultNamingFunction();
      saveCustomNamingFunction(''); // Vider le localStorage
      addLog("🔄 Fonction par défaut restaurée");
    }
  });
  
  // Assemblage
  container.appendChild(title);
  container.appendChild(statusDiv);
  container.appendChild(configDiv);
  container.appendChild(logsDiv);
  
  // Groupe de boutons principaux
  const mainButtonsDiv = document.createElement("div");
  mainButtonsDiv.style.marginBottom = "10px";
  mainButtonsDiv.appendChild(startButton);
  mainButtonsDiv.appendChild(testButton);
  mainButtonsDiv.appendChild(resetButton);
  mainButtonsDiv.appendChild(toggleLogsButton);
  
  // Groupe de boutons de configuration
  const configButtonsDiv = document.createElement("div");
  configButtonsDiv.style.marginBottom = "10px";
  configButtonsDiv.appendChild(saveFunctionButton);
  configButtonsDiv.appendChild(resetFunctionButton);
  
  container.appendChild(mainButtonsDiv);
  container.appendChild(configButtonsDiv);
  
  const card = sdk.ui.card({ body: container });
  sdk.navigation.addPage("/replay-tab-renamer", { body: card });
  sdk.sidebar.registerItem("Replay Tabs", "/replay-tab-renamer", {
    icon: "fas fa-tag"
  });
  
  // Fonctions utilitaires
  function addLog(message: string) {
    if (!logsEnabled) return; // Ne pas logger si les logs sont désactivés
    
    const logContainer = document.getElementById("activity-logs");
    if (logContainer) {
      if (logContainer.querySelector("em")) {
        logContainer.innerHTML = "";
      }
      
      const timestamp = new Date().toLocaleTimeString();
      const logEntry = document.createElement("div");
      logEntry.textContent = `[${timestamp}] ${message}`;
      logEntry.style.color = "#00ff00";
      logEntry.style.marginBottom = "2px";
      
      logContainer.insertBefore(logEntry, logContainer.firstChild);
      
      while (logContainer.children.length > 50) {
        logContainer.removeChild(logContainer.lastChild);
      }
    }
  }
  
  function updateStatus(status: string) {
    const statusElement = document.getElementById("polling-status");
    if (statusElement) {
      statusElement.textContent = status;
    }
  }
  
  function updateLogsStatus(status: string) {
    const statusElement = document.getElementById("logs-status");
    if (statusElement) {
      statusElement.textContent = status;
    }
  }
  
  function updateCounts(total: number, known: number, newCount: number) {
    const elements = {
      sessions: document.getElementById("sessions-count"),
      known: document.getElementById("known-count"), 
      new: document.getElementById("new-count")
    };
    
    if (elements.sessions) elements.sessions.textContent = total.toString();
    if (elements.known) elements.known.textContent = known.toString();
    if (elements.new) elements.new.textContent = newCount.toString();
  }
  
  function generateTabName(method: string, path: string, host?: string): string {
    try {
      // Essayer d'utiliser la fonction personnalisée
      const customFunction = getCustomNamingFunction();
      
      if (customFunction.trim()) {
        // Créer une fonction à partir du code personnalisé
        const userFunction = new Function('method', 'path', 'host', customFunction);
        const result = userFunction(method, path, host || '');
        
        if (typeof result === 'string' && result.trim()) {
          return result.trim();
        }
      }
    } catch (error) {
      addLog(`⚠️ Erreur fonction personnalisée: ${error.message}`);
      addLog("🔄 Utilisation de la fonction par défaut");
    }
    
    // Fonction par défaut en cas d'erreur ou si pas de fonction personnalisée
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
      const auth = JSON.parse(localStorage.getItem("CAIDO_AUTHENTICATION") || "{}");
      const accessToken = auth.accessToken;
      
      if (!accessToken) {
        throw new Error("Token manquant");
      }
      
      const response = await fetch("/graphql", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          query: "query replaySession($id:String!){replaySession(id:$id){activeEntry{createdAt raw session{id name}}}}",
          variables: { id: sessionId },
          operationName: "replaySession",
        }),
      });
      
      const data = await response.json();
      return data.data?.replaySession?.activeEntry;
    } catch (error) {
      console.error("Erreur getSessionDetails:", error);
      return null;
    }
  }
  
  function parseRawRequest(raw: string) {
    try {
      if (!raw || typeof raw !== 'string') {
        return null;
      }
      
      // Debug: afficher le raw pour voir son format
      console.log("Raw request:", raw.substring(0, 200));
      
      // Normaliser les retours à la ligne
      const normalizedRaw = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      const lines = normalizedRaw.split('\n');
      
      if (lines.length === 0) {
        return null;
      }
      
      // Trouver la ligne de requête (première ligne non-vide)
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
      
      // Parser la ligne de requête: METHOD PATH HTTP/VERSION
      const parts = requestLine.split(/\s+/);
      if (parts.length < 2) {
        return null;
      }
      
      const method = parts[0];
      const path = parts[1];
      
      // Chercher le header Host (plus robuste)
      let host = '';
      for (const line of lines) {
        const trimmedLine = line.trim();
        if (trimmedLine.toLowerCase().startsWith('host:')) {
          host = trimmedLine.substring(5).trim();
          break;
        }
      }
      
      // Valider les résultats
      if (!method || !path) {
        return null;
      }
      
      return { method, path, host };
      
    } catch (error) {
      console.error("Erreur parseRawRequest:", error);
      return null;
    }
  }
  
  async function checkAndRenameReplayTabs() {
    try {
      addLog("🔍 Vérification des sessions...");
      
      const sessions = await sdk.replay.getSessions();
      
      if (!sessions || sessions.length === 0) {
        addLog("ℹ️ Aucune session trouvée");
        updateCounts(0, 0, 0);
        return;
      }
      
      const knownSessions = getKnownSessions();
      const currentSessionIds = new Set(sessions.map(s => s.id));
      const newSessions = sessions.filter(session => !knownSessions.has(session.id));
      
      addLog(`📊 ${sessions.length} total, ${knownSessions.size} connues, ${newSessions.length} nouvelles`);
      updateCounts(sessions.length, knownSessions.size, newSessions.length);
      
      if (newSessions.length === 0) {
        addLog("ℹ️ Aucune nouvelle session");
        saveKnownSessions(currentSessionIds);
        return;
      }
      
      let renamedCount = 0;
      
      for (const session of newSessions) {
        try {
          addLog(`🆕 Traitement session ${session.id}...`);
          
          const entry = await getSessionDetails(session.id);
          if (!entry || !entry.raw) {
            addLog(`⚠️ Pas de détails pour ${session.id}`);
            continue;
          }
          
          const currentName = entry.session?.name || session.name;
          const requestInfo = parseRawRequest(atob(entry.raw));
          
          if (!requestInfo) {
            addLog(`⚠️ Impossible de parser ${session.id}`);
            continue;
          }
          
          const newName = generateTabName(requestInfo.method, requestInfo.path);
          
          if (currentName === newName) {
            addLog(`✅ ${session.id} déjà correct`);
            continue;
          }
          
          await sdk.replay.renameSession(session.id, newName);
          
          addLog(`🏷️ ${session.id} → "${newName}"`);
          addLog(`   📍 ${requestInfo.method} ${requestInfo.host}${requestInfo.path}`);
          
          renamedCount++;
          
          await new Promise(resolve => setTimeout(resolve, 100));
          
        } catch (error) {
          addLog(`❌ Erreur ${session.id}: ${error}`);
        }
      }
      
      saveKnownSessions(currentSessionIds);
      addLog(`💾 ${currentSessionIds.size} sessions sauvées`);
      
      if (renamedCount > 0) {
        addLog(`🎉 ${renamedCount} sessions renommées`);
      }
      
      const finalKnown = getKnownSessions();
      updateCounts(sessions.length, finalKnown.size, 0);
      
    } catch (error) {
      addLog(`❌ Erreur: ${error}`);
      console.error("Erreur checkAndRenameReplayTabs:", error);
    }
  }
  
  function startPolling() {
    if (pollingInterval) {
      clearInterval(pollingInterval);
    }
    
    isPolling = true;
    checkAndRenameReplayTabs();
    
    pollingInterval = setInterval(() => {
      checkAndRenameReplayTabs();
    }, 3000);
    
    addLog("🔄 Polling démarré");
  }
  
  function stopPolling() {
    if (pollingInterval) {
      clearInterval(pollingInterval);
      pollingInterval = null;
    }
    
    isPolling = false;
    addLog("⏹️ Polling arrêté");
  }
  
  // Initialisation
  const knownSessions = getKnownSessions();
  addLog(`🔄 ${knownSessions.size} sessions en mémoire`);
  updateCounts(0, knownSessions.size, 0);
  
  setTimeout(() => {
    startPolling();
    updateStatus("Oui");
  }, 2000);
  
  console.log("✅ Plugin initialisé");
}