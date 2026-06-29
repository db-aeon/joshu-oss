/** In-app GUI action queued from Hermes app_gui_action (executed in the browser). */
export type AppGuiAction = {
  appId: string;
  action: string;
  args?: Record<string, unknown>;
};
