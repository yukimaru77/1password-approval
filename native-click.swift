#!/usr/bin/swift

import ApplicationServices
import Foundation

guard CommandLine.arguments.count == 3,
      let x = Double(CommandLine.arguments[1]),
      let y = Double(CommandLine.arguments[2]) else {
  fputs("usage: native-click.swift <x> <y>\n", stderr)
  exit(64)
}

let point = CGPoint(x: x, y: y)
let source = CGEventSource(stateID: .hidSystemState)
source?.localEventsSuppressionInterval = 0

guard let down = CGEvent(
  mouseEventSource: source,
  mouseType: .leftMouseDown,
  mouseCursorPosition: point,
  mouseButton: .left
),
let up = CGEvent(
  mouseEventSource: source,
  mouseType: .leftMouseUp,
  mouseCursorPosition: point,
  mouseButton: .left
) else {
  fputs("failed to create mouse events\n", stderr)
  exit(1)
}

down.post(tap: .cghidEventTap)
usleep(80_000)
up.post(tap: .cghidEventTap)
