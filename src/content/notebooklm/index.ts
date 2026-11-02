import type { DriverCommand } from "../../shared/messages";
import { handleCommand } from "./driver";
import { startOrganizer } from "./organizer";

chrome.runtime.onMessage.addListener((msg: { __driver?: DriverCommand }, _sender, sendResponse) => {
  if (!msg?.__driver) return false;
  void handleCommand(msg.__driver).then(sendResponse);
  return true; // réponse asynchrone
});

startOrganizer();
