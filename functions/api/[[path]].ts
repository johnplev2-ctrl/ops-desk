// Every /api/* request lands here. Static files in /public are served without invoking a Function.
import { handle, type AppEnv } from "../../src/router";

export const onRequest: PagesFunction<AppEnv> = (context) => handle(context);
