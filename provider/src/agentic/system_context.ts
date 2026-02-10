import os from "os"
import type { AIContextItem } from "./types"

export function getSystemContextItems(): AIContextItem[] {
  const platform = os.platform()
  const arch = os.arch()
  return [
    {
      category: "os_information",
      content: `<os><platform>${platform}</platform><architecture>${arch}</architecture></os>`,
      id: "os_information",
      metadata: {
        title: "Operating System",
        enabled: true,
        subType: "os",
        icon: "monitor",
        secondaryText: `${platform} ${arch}`,
        subTypeLabel: "System Information",
      },
    },
  ]
}
