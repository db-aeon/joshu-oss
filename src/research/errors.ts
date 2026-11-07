/**
 * The step of a Research report or of a run of a recurring report that failed. The companion names
 * it when it tells the owner. `group`, `compare`, and `send` are steps of a run (change
 * recurring-research-reports, design decision D3). `learn` is a model call of the content goals
 * client (change content-router, D2); its failure never fails a report. `themes` sorts the stories
 * of a report into themes (change research-report-topics, D5).
 */
export type ResearchStep = "plan" | "search" | "extract" | "collect" | "learn" | "group" | "compare" | "themes" | "write" | "render" | "store" | "send";

export class ResearchStepError extends Error {
  readonly step: ResearchStep;

  constructor(step: ResearchStep, message: string) {
    super(message);
    this.name = "ResearchStepError";
    this.step = step;
  }
}
