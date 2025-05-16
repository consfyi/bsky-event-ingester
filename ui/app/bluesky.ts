import { LABELER_DID } from "./config";

export interface Profile {
  did: string;
  handle: string;
  displayName: string;
  avatar: string;
  description: string;
}

export interface LabelValueDefinitionStrings {
  description: string;
  lang: string;
  name: string;
}

export interface LabelValueDefinition {
  fbl_eventInfo: { date: string; location: string };
  fbl_postRkey: string;
  identifier: string;
  locales: LabelValueDefinitionStrings[];
}

export interface LabelerPolicies {
  labelValueDefinitions: LabelValueDefinition[];
}

export interface LabelerView {
  creator: Profile;
  policies: LabelerPolicies;
}

export interface Like {
  actor: Profile;
}

export class Client {
  private endpoint: string;

  constructor(endpoint: string = "https://public.api.bsky.app") {
    this.endpoint = endpoint;
  }

  async getProfile(actor: string): Promise<Profile> {
    const resp = await fetch(
      `${this.endpoint}/xrpc/app.bsky.actor.getProfile?actor=${actor}`
    );
    if (!resp.ok) {
      throw resp;
    }

    return await resp.json();
  }

  async getLabelerView(did: string): Promise<LabelerView> {
    const resp = await fetch(
      `${this.endpoint}/xrpc/app.bsky.labeler.getServices?dids=${did}&detailed=true`
    );
    if (!resp.ok) {
      throw resp;
    }

    const {
      views: [view],
    } = await resp.json();
    return view;
  }

  async *getFollows(actor: string): AsyncGenerator<Profile> {
    const LIMIT = 100;
    let cursor = "";
    while (true) {
      const resp = await fetch(
        `${this.endpoint}/xrpc/app.bsky.graph.getFollows?actor=${actor}&limit=${LIMIT}&cursor=${cursor}`
      );
      if (!resp.ok) {
        throw resp;
      }

      const payload = await resp.json();
      yield* payload.follows;
      if (!payload.cursor) {
        break;
      }
      cursor = payload.cursor;
    }
  }

  async *getLikes(uri: string): AsyncGenerator<Like> {
    const LIMIT = 100;
    let cursor = "";
    while (true) {
      const resp = await fetch(
        `${this.endpoint}/xrpc/app.bsky.feed.getLikes?uri=${uri}&limit=${LIMIT}&cursor=${cursor}`
      );
      if (!resp.ok) {
        throw resp;
      }

      const payload = await resp.json();
      yield* payload.likes;
      if (!payload.cursor) {
        break;
      }
      cursor = payload.cursor;
    }
  }

  async *getLabels(did: string): AsyncGenerator<string> {
    const LIMIT = 250;
    let cursor = "";
    while (true) {
      const resp = await fetch(
        `${this.endpoint}/xrpc/com.atproto.label.queryLabels?sources=${LABELER_DID}&uriPatterns=${did}&limit=${LIMIT}&cursor=${cursor}`
      );
      if (!resp.ok) {
        throw resp;
      }

      const payload = await resp.json();
      for (const label of payload.labels) {
        yield label.val;
      }
      if (!payload.cursor) {
        break;
      }
      cursor = payload.cursor;
    }
  }
}

export const CLIENT = new Client();
