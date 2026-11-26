/**
 * What an installed app says about a folder it can no longer reach. It is told the folder is out of
 * reach and not why, so the sentences name the things a person can check.
 */
export const LOST_FOLDER_CAUSES = 'It may have been moved, renamed or deleted, or EtherPK may have lost its permission.'

export const LOST_GRAPH_FOLDER = `EtherPK can no longer open this graph’s folder. ${LOST_FOLDER_CAUSES}`
export const LOST_GRAPH_FOLDER_NEXT = 'Choose the folder again to open the graph. Nothing in it is changed.'

export const lostPlainFolder = (name: string) => `EtherPK can no longer open the folder “${name}”. ${LOST_FOLDER_CAUSES}`
export const LOST_PLAIN_FOLDER_NEXT = 'Choose the folder again to open it.'

export const LOST_PUBLISH_FOLDER = `EtherPK can no longer open the folder this publication is written to. ${LOST_FOLDER_CAUSES} Choose a folder again in Settings, under Publish.`

export const lostFolderOf = (graph: string) => `EtherPK can no longer open the folder of “${graph}”. ${LOST_FOLDER_CAUSES} Open the graph to choose its folder again.`
