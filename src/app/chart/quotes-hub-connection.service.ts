import { inject, Injectable, PLATFORM_ID } from "@angular/core";
import { isPlatformBrowser } from "@angular/common";
import * as signalR from "@microsoft/signalr";
import { WidgetConfigService } from "./widget-config.service";

@Injectable({
  providedIn: "root",
})
export class QuotesHubConnectionService {
  private connection: signalR.HubConnection | null = null;
  private startPromise: Promise<void> | null = null;
  private lifecycleHandlersBound = false;
  private readonly reconnectedListeners = new Set<() => void | Promise<void>>();
  private readonly reconnectingListeners = new Set<
    (error?: Error) => void | Promise<void>
  >();

  private readonly platformId = inject(PLATFORM_ID);
  private readonly isBrowser: boolean = isPlatformBrowser(this.platformId);
  private widgetConfig = inject(WidgetConfigService);

  constructor() {}

  getConnection(): signalR.HubConnection {
    if (!this.connection) {
      this.connection = new signalR.HubConnectionBuilder()
        .withUrl(this.buildHubUrl())
        .withAutomaticReconnect()
        .build();
      this.bindLifecycleHandlers(this.connection);
    }

    return this.connection;
  }

  addReconnectedListener(
    listener: () => void | Promise<void>,
  ): () => void {
    const connection = this.getConnection();
    this.bindLifecycleHandlers(connection);
    this.reconnectedListeners.add(listener);

    return () => {
      this.reconnectedListeners.delete(listener);
    };
  }

  addReconnectingListener(
    listener: (error?: Error) => void | Promise<void>,
  ): () => void {
    const connection = this.getConnection();
    this.bindLifecycleHandlers(connection);
    this.reconnectingListeners.add(listener);

    return () => {
      this.reconnectingListeners.delete(listener);
    };
  }

  async ensureConnected(): Promise<signalR.HubConnection> {
    if (!this.isBrowser) {
      throw new Error("SignalR connection is only available in browser.");
    }

    const connection = this.getConnection();
    if (connection.state === signalR.HubConnectionState.Connected) {
      return connection;
    }

    if (connection.state === signalR.HubConnectionState.Connecting) {
      await this.waitUntilConnected(connection, 8000);
      return connection;
    }

    if (connection.state === signalR.HubConnectionState.Disconnected) {
      if (!this.startPromise) {
        this.startPromise = connection.start().finally(() => {
          this.startPromise = null;
        });
      }

      await this.startPromise;
      return connection;
    }

    await this.waitUntilConnected(connection, 8000);
    return connection;
  }

  private bindLifecycleHandlers(connection: signalR.HubConnection): void {
    if (this.lifecycleHandlersBound) {
      return;
    }

    connection.onreconnecting((error) => {
      for (const listener of this.reconnectingListeners) {
        void Promise.resolve(listener(error ?? undefined)).catch((callbackError) => {
          console.error("SignalR reconnecting listener failed", callbackError);
        });
      }
    });

    connection.onreconnected(() => {
      for (const listener of this.reconnectedListeners) {
        void Promise.resolve(listener()).catch((callbackError) => {
          console.error("SignalR reconnected listener failed", callbackError);
        });
      }
    });

    this.lifecycleHandlersBound = true;
  }

  private buildHubUrl(): string {
    const rootUrl = (this.widgetConfig.hubUrl || "").replace(/\/$/, "");
    if (!rootUrl) {
      throw new Error("Hub URL is not configured.");
    }

    return `${rootUrl}/hubs/quotes`;
  }

  private async waitUntilConnected(
    connection: signalR.HubConnection,
    timeoutMs: number,
  ): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (connection.state === signalR.HubConnectionState.Connected) {
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    throw new Error("Timeout waiting for SignalR connected state.");
  }
}
