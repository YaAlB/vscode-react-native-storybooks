import createChannel from "@storybook/channel-websocket"
import * as vscode from "vscode"

import * as WebSocket from "ws"
const g = global as any
g.WebSocket = WebSocket

import * as glob from "glob"
import * as fs from "fs"

import { StoryTreeProvider, StoryObj, Story } from "./tree-provider"
import { StoryPickerProvider, StorySelection } from "./picker-provider"

var storybooksChannel: any
var connectedOnce = false

export function activate(context: vscode.ExtensionContext) {
  console.log("Started storybooks")
  vscode.commands.executeCommand("setContext", "is-running-storybooks-vscode", true)

  let previewUri = vscode.Uri.parse("storybook://authority/preview")
  class TextDocumentContentProvider implements vscode.TextDocumentContentProvider {
    public provideTextDocumentContent(uri: vscode.Uri): string {
      const port = vscode.workspace.getConfiguration("react-native-storybooks").get("port")
      const host = vscode.workspace.getConfiguration("react-native-storybooks").get("host")

      return `
            <style>iframe {
                position: fixed;
                border: none;
                top: 0; right: 0;
                bottom: 0; left: 0;
                width: 100%;
                height: 100%;
            }
            </style>

            <body onload="iframe.document.head.appendChild(ifstyle)" style="background-color:red;margin:0px;padding:0px;overflow:hidden">
                <iframe src="http://${host}:${port}" frameborder="0"></iframe>
                <p>If you're seeing this, something is wrong :) (can't find server at ${host}:${port})</p>
            </body>
            `
    }
  }

  let provider = new TextDocumentContentProvider()
  let registration = vscode.workspace.registerTextDocumentContentProvider("storybook", provider)

  const storiesProvider = new StoryTreeProvider()
  vscode.window.registerTreeDataProvider("storybook", storiesProvider)

  const pickerProvider = new StoryPickerProvider(storiesProvider)

  // Registers the storyboards command to trigger a new HTML preview which hosts the storybook server
  let disposable = vscode.commands.registerCommand("extension.showStorybookPreview", () => {
    return vscode.commands.executeCommand("vscode.previewHtml", previewUri, vscode.ViewColumn.Two, "Storybooks").then(
      success => {},
      reason => {
        vscode.window.showErrorMessage(reason)
      }
    )
  })

  context.subscriptions.push(disposable, registration)

  const host = vscode.workspace.getConfiguration("react-native-storybooks").get("host")
  const port = vscode.workspace.getConfiguration("react-native-storybooks").get("port")

  storybooksChannel = createChannel({ url: `ws://${host}:${port}`, async: true, onError: () => {} })
  var currentKind: string = null
  var currentStory: string = null
  var currentStoryId: string = null

  // Create a statusbar item to reconnect, when we lose connection
  const reconnectStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left)
  reconnectStatusBarItem.command = "extension.restartConnectionToStorybooks"
  if (connectedOnce) {
    reconnectStatusBarItem.text = "Reconnect Storybooks"
    reconnectStatusBarItem.color = "#FF8989"
  } else {
    reconnectStatusBarItem.text = "Connect to Storybooks"
  }

  reconnectStatusBarItem.hide()

  // So when we re-connect, callbacks can happen on the new socket connection
  const registerCallbacks = channel => {
    // Called when we get stories from the RN client
    channel.on("setStories", data => {
      const filter = vscode.workspace.getConfiguration("react-native-storybooks").get("storybookFilterRegex") as string
      const regex = new RegExp(filter)
      let stories: Story[] = []
      if (Array.isArray(data.stories)) {
        let kinds: { [key: string]: StoryObj[] } = {}
        const storydata = data.stories.filter(s => s.kind.match(regex))

        storydata.map(story => {
          story.stories.map(singleStory => {
            if (kinds[story.kind] == undefined) {
              // kinds[story.kind] = [story.name]
              kinds[story.kind] = [{ name: singleStory, id: singleStory }]
            } else {
              kinds[story.kind].push({ name: singleStory, id: singleStory })
            }
          })
        })
        Object.keys(kinds).forEach(function(key) {
          stories.push({
            kind: key,
            stories: kinds[key]
          })
        })
      } else {
        let kinds: { [key: string]: StoryObj[] } = {}
        Object.keys(data.stories).forEach(function(key) {
          const story = data.stories[key]
          if (story.kind.match(regex)) {
            if (kinds[story.kind] == undefined) {
              // kinds[story.kind] = [story.name]
              kinds[story.kind] = [{ name: story.name, id: story.id }]
            } else {
              kinds[story.kind].push({ name: story.name, id: story.id })
            }
          }
        })
        Object.keys(kinds).forEach(function(key) {
          stories.push({
            kind: key,
            stories: kinds[key]
          })
        })
      }
      storiesProvider.stories = stories
      storiesProvider.refresh()
      reconnectStatusBarItem.hide()
    })

    // When the server in RN starts up, it asks what should be default
    channel.on("getCurrentStory", () => {
      storybooksChannel.emit("setCurrentStory", {
        storyId: currentStoryId
      })
    })

    // The React Native server has closed
    channel.transport.socket.onclose = () => {
      storiesProvider.stories = []
      storiesProvider.refresh()
      reconnectStatusBarItem.show()
    }

    channel.emit("getStories")
  }
  registerCallbacks(storybooksChannel)

  vscode.commands.registerCommand("extension.searchStories", () => {
    vscode.window.showQuickPick(pickerProvider.toList()).then((picked: string) => {
      const setParams = pickerProvider.getParts(picked)
      setCurrentStory(setParams)
    })
  })

  // Allow clicking, and keep state on what is selected
  vscode.commands.registerCommand("extension.openStory", (section, story) => {
    // Handle a Double click
    if (currentStoryId === story.id && currentKind === section.kind && currentStory === story.name) {
      findFileForStory(section.kind, story.name).then(results => {
        if (results) {
          vscode.workspace.openTextDocument(results.uri).then(doc => {
            vscode.window.showTextDocument(doc).then(shownDoc => {
              let range = doc.lineAt(results.line - 1).range
              vscode.window.activeTextEditor.selection = new vscode.Selection(range.start, range.end)
              vscode.window.activeTextEditor.revealRange(range, vscode.TextEditorRevealType.InCenter)
            })
          })
        }
      })
      return
    }

    setCurrentStory({ storyId: story.id, kind: section.kind, story: story.name })
  })

  function setCurrentStory(params: StorySelection) {
    const currentChannel = () => storybooksChannel
    currentKind = params.kind
    currentStory = params.story
    currentStoryId = params.storyId
    currentChannel().emit("setCurrentStory", params)
  }

  vscode.commands.registerCommand("extension.connectToStorybooks", () => {
    storybooksChannel = createChannel({ url: `ws://${host}:${port}`, async: true, onError: () => {} })
    registerCallbacks(storybooksChannel)
  })

  vscode.commands.registerCommand("extension.restartConnectionToStorybooks", () => {
    storybooksChannel = createChannel({ url: `ws://${host}:${port}`, async: true, onError: () => {} })
    registerCallbacks(storybooksChannel)
  })

  // These are a bit alpha-y, as I don't think I can control what is showing as selected inside the VS Code UI
  vscode.commands.registerCommand("extension.goToNextStorybook", () => {
    const stories = storiesProvider.stories
    const currentSection = stories.find(s => s.kind === currentKind)
    const currentStories = currentSection.stories
    const currentIndex = currentStories.map(e => e.id).indexOf(currentStoryId)
    if (currentIndex === currentStories.length) {
      // go around or something
      vscode.commands.executeCommand("extension.openStory", currentSection, currentStories[0])
    } else {
      vscode.commands.executeCommand("extension.openStory", currentSection, currentStories[currentIndex + 1])
    }
  })

  vscode.commands.registerCommand("extension.goToPreviousStorybook", () => {
    const stories = storiesProvider.stories
    const currentSection = stories.find(s => s.kind === currentKind)
    const currentStories = currentSection.stories
    const currentIndex = currentStories.map(e => e.id).indexOf(currentStoryId)
    if (currentIndex === 0) {
      // go around or something
      vscode.commands.executeCommand("extension.openStory", currentSection, currentStories[currentStories.length - 1])
    } else {
      vscode.commands.executeCommand("extension.openStory", currentSection, currentStories[currentIndex - 1])
    }
  })

  vscode.commands.registerCommand("extension.expandAllStories", () => {
    storiesProvider.expandAll()
  })

  vscode.commands.registerCommand("extension.collapseAllStories", () => {
    storiesProvider.collapseAll()
  })
}

// Loop through all globbed stories,
// reading the files for the kind and the story name

const findFileForStory = async (kind: string, story: string): Promise<{ uri: vscode.Uri; line: number } | null> => {
  return new Promise<{ uri: vscode.Uri; line: number }>((resolve, reject) => {
    const regex = vscode.workspace.getConfiguration("react-native-storybooks").get("storyRegex") as string

    const root = vscode.workspace.workspaceFolders
    vscode.workspace.findFiles(regex, "**/node_modules").then(files => {
      let found = false
      for (const file of files) {
        const content = fs.readFileSync(file.fsPath, "utf8")
        if (content.includes(kind) && content.includes(story)) {
          const line = content.split(story)[0].split("\n").length
          resolve({ uri: file, line })
          found = true
        }
      }
      if (!found) {
        resolve(null)
      }
    })
  })
}

export function deactivate() {
  storybooksChannel.transport.socket.close()
}
