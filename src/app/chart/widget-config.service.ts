import { Injectable } from "@angular/core";

/**
 * Simple injectable that holds the hub URL provided to the widget
 * via query params. Replaces ApiConfiguration from the host projects.
 */
@Injectable({
  providedIn: "root",
})
export class WidgetConfigService {
  hubUrl = "";
}
