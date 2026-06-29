import { z } from "zod";
import { useEffect } from "react";
import { useFrontendTool } from "@copilotkit/react-core/v2";

import { registerAppGuiActionHandler } from "./appGuiActionDispatch.js";

export type JoshuGuiActionInput<T extends Record<string, unknown> = Record<string, unknown>> = {
  name: string;
  description: string;
  parameters?: Array<{
    name: keyof T & string;
    type: "string" | "number" | "boolean" | "object";
    description?: string;
    required?: boolean;
  }>;
  handler: (args: T) => Promise<string> | string;
};

function buildParameterSchema(
  parameters?: JoshuGuiActionInput["parameters"],
): z.ZodObject<Record<string, z.ZodTypeAny>> {
  if (!parameters?.length) return z.object({});

  const shape: Record<string, z.ZodTypeAny> = {};
  for (const param of parameters) {
    let field: z.ZodTypeAny =
      param.type === "number"
        ? z.number()
        : param.type === "boolean"
          ? z.boolean()
          : param.type === "object"
            ? z.record(z.unknown())
            : z.string();
    if (param.description) field = field.describe(param.description);
    if (!param.required) field = field.optional();
    shape[param.name] = field;
  }
  return z.object(shape);
}

/** Register a frontend tool that mirrors a GUI action (CopilotKit useFrontendTool wrapper). */
export function useJoshuGuiAction<T extends Record<string, unknown> = Record<string, unknown>>(
  action: JoshuGuiActionInput<T>,
  deps: any[] = [],
): void {
  const schema = buildParameterSchema(action.parameters);

  useFrontendTool(
    {
      name: action.name,
      description: action.description,
      parameters: schema,
      handler: async (args) => {
        const result = await action.handler(args as T);
        return typeof result === "string" ? result : JSON.stringify(result);
      },
    },
    deps,
  );

  useEffect(() => {
    return registerAppGuiActionHandler(action.name, (args) => action.handler(args as T));
  }, [action.name, action.handler, ...deps]);
}
