import { useRef } from 'react'
import Header from './components/Header'
import RequestActiveTab from './components/RequestActiveTab'
import RequestPane from './components/RequestPane'
import Sidebar from './components/Sidebar'
import Toolbar from './components/Toolbar'
import { useAppPreferences } from './hooks/useAppPreferences'
import { useRequestWorkspace } from './hooks/useRequestWorkspace'
import { useResponseSplitter } from './hooks/useResponseSplitter'
import { useWorkspaceData } from './hooks/useWorkspaceData'
import { REQUEST_TABS } from './lib/requestDocument'
import { isTauriRuntime } from './tauri'

function App() {
  const importInputRef = useRef<HTMLInputElement>(null)
  const { orientation, setOrientation, setTheme, theme } = useAppPreferences()
  const workspace = useWorkspaceData()
  const request = useRequestWorkspace({
    environmentVariables: workspace.environmentVariables,
    selectedRequest: workspace.selectedRequest,
    setError: workspace.setError,
  })
  const responseSplitter = useResponseSplitter(orientation)

  const activeTabContent = (
    <RequestActiveTab
      activeTab={request.activeTab}
      bodyDraft={request.bodyDraft}
      bodyIsValid={request.bodyIsValid}
      description={request.description}
      headers={request.headers}
      params={request.params}
      requestContentType={request.requestContentType}
      responseExamples={request.responseExamples}
      scripts={request.scripts}
      selectedCollection={workspace.selectedCollection}
      selectedDocument={request.selectedDocument}
      selectedRequest={workspace.selectedRequest}
      setBodyDraft={request.setBodyDraft}
      urlDraft={request.urlDraft}
    />
  )

  return (
    <main className="h-screen overflow-hidden bg-[var(--bg)] text-[var(--text)]">
      <Header selectedRequest={workspace.selectedRequest} />
      <Toolbar
        workspaces={workspace.workspaces}
        selectedWorkspaceId={workspace.selectedWorkspaceId}
        setSelectedWorkspaceId={workspace.setSelectedWorkspaceId}
        loadingWorkspaces={workspace.loadingWorkspaces}
        workspaceName={workspace.workspaceName}
        setWorkspaceName={workspace.setWorkspaceName}
        handleCreateWorkspace={workspace.handleCreateWorkspace}
        theme={theme}
        setTheme={setTheme}
        orientation={orientation}
        setOrientation={setOrientation}
      />

      <div className="flex h-[calc(100vh-92px)] min-h-0">
        <Sidebar
          importInputRef={importInputRef}
          handleImportFile={workspace.handleImportFile}
          handleCreateCollection={workspace.handleCreateCollection}
          collectionName={workspace.collectionName}
          setCollectionName={workspace.setCollectionName}
          selectedWorkspace={workspace.selectedWorkspace}
          environments={workspace.environments}
          selectedEnvironmentId={workspace.selectedEnvironmentId}
          setSelectedEnvironmentId={workspace.setSelectedEnvironmentId}
          environmentName={workspace.environmentName}
          setEnvironmentName={workspace.setEnvironmentName}
          handleCreateEnvironment={workspace.handleCreateEnvironment}
          environmentVariables={workspace.environmentVariables}
          variableKey={workspace.variableKey}
          setVariableKey={workspace.setVariableKey}
          variableValue={workspace.variableValue}
          setVariableValue={workspace.setVariableValue}
          handleSaveVariable={workspace.handleSaveVariable}
          handleEditVariable={workspace.handleEditVariable}
          handleDeleteVariable={workspace.handleDeleteVariable}
          isTauriRuntime={isTauriRuntime}
          error={workspace.error}
          notice={workspace.notice}
          loadingCollections={workspace.loadingCollections}
          collections={workspace.collections}
          loadingRequests={workspace.loadingRequests}
          foldersByParent={workspace.foldersByParent}
          requestsByFolder={workspace.requestsByFolder}
          selectedCollectionId={workspace.selectedCollectionId}
          setSelectedCollectionId={workspace.setSelectedCollectionId}
          selectedRequestId={workspace.selectedRequestId}
          setSelectedRequestId={workspace.setSelectedRequestId}
          openFolderIds={workspace.openFolderIds}
          toggleFolder={workspace.toggleFolder}
          handleRenameCollection={workspace.handleRenameCollection}
          handleDeleteCollection={workspace.handleDeleteCollection}
        />

        <RequestPane
          activeTab={request.activeTab}
          activeTabContent={activeTabContent}
          selectedRequest={workspace.selectedRequest}
          selectedCollection={workspace.selectedCollection}
          urlDraft={request.urlDraft}
          setUrlDraft={request.setUrlDraft}
          handleSend={request.handleSend}
          sending={request.sending}
          setActiveTab={request.setActiveTab}
          resolvedUrlPreview={request.resolvedUrlPreview}
          handleBeautifyBody={request.handleBeautifyBody}
          REQUEST_TABS={REQUEST_TABS}
          headers={request.headers}
          selectedDocument={request.selectedDocument}
          requestContentType={request.requestContentType}
          setRequestContentType={request.setRequestContentType}
          responseExamples={request.responseExamples}
          selectedResponseIndex={request.selectedResponseIndex}
          setSelectedResponseIndex={request.setSelectedResponseIndex}
          selectedResponse={request.selectedResponse}
          sendResult={request.sendResult}
          sendError={request.sendError}
          responseHeight={responseSplitter.responseHeight}
          responseWidth={responseSplitter.responseWidth}
          orientation={orientation}
          responseSplitRef={responseSplitter.responseSplitRef}
          setIsResizingResponse={responseSplitter.setIsResizingResponse}
          responseViewTab={request.responseViewTab}
          setResponseViewTab={request.setResponseViewTab}
          responseContentType={request.responseContentType}
          setResponseContentType={request.setResponseContentType}
          responseStatusCode={request.responseStatusCode}
          setResponseStatusCode={request.setResponseStatusCode}
        />
      </div>
    </main>
  )
}

export default App
