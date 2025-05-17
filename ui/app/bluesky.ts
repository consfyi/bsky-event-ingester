import {
  simpleFetchHandler,
  Client as AtcuteClient,
  buildFetchHandler,
} from "@atcute/client";
import { LABELER_DID } from "./config";
import type {} from "@atcute/bluesky";
import type {} from "@atcute/atproto";
import type {
  ActorIdentifier,
  Did,
  Handle,
  ResourceUri,
} from "@atcute/lexicons";
import { PostView } from "@atcute/bluesky/types/app/feed/defs";
import { OAuthUserAgent, Session } from "@atcute/oauth-browser-client";

export interface Profile {
  did: Did;
  handle: Handle;
  displayName?: string | undefined;
  avatar?: string | undefined;
  description?: string | undefined;
}

export interface LabelValueDefinitionStrings {
  description: string;
  lang: string;
  name: string;
}

export interface LabelValueDefinition {
  fbl_eventInfo: { date: string; location: string; url: string };
  fbl_postRkey: string;
  identifier: string;
  locales: LabelValueDefinitionStrings[];
}

export interface LabelerPolicies {
  labelValueDefinitions?: LabelValueDefinition[];
}

export interface LabelerView {
  creator: Profile;
  policies?: LabelerPolicies;
}

export interface Like {
  actor: Profile;
}

export class Client {
  private oauthUserAgent: OAuthUserAgent | null;
  private rpc: AtcuteClient;
  public readonly did: Did | null;

  constructor(session: Session | null = null) {
    this.oauthUserAgent = session != null ? new OAuthUserAgent(session) : null;
    this.rpc = new AtcuteClient({
      handler:
        this.oauthUserAgent != null
          ? buildFetchHandler(this.oauthUserAgent)
          : simpleFetchHandler({
              service: "https://public.api.bsky.app",
            }),
    });
    this.did = session != null ? session.info.sub : null;
  }

  async signOut() {
    if (this.oauthUserAgent == null) {
      return;
    }
    await this.oauthUserAgent.signOut();
  }

  async *getAuthorPosts(actor: ActorIdentifier): AsyncGenerator<PostView> {
    const LIMIT = 100;
    let cursor = "";
    while (true) {
      const { ok, data } = await this.rpc.get("app.bsky.feed.getAuthorFeed", {
        params: {
          actor,
          limit: LIMIT,
          cursor,
          includePins: false,
          filter: "posts_no_replies",
        },
      });
      if (!ok) {
        throw data.error;
      }

      for (const feedView of data.feed) {
        yield feedView.post;
      }
      if (!data.cursor) {
        break;
      }
      cursor = data.cursor;
    }
  }

  async getProfile(actor: ActorIdentifier): Promise<Profile> {
    const { ok, data } = await this.rpc.get("app.bsky.actor.getProfile", {
      params: { actor },
    });
    if (!ok) {
      throw data.error;
    }
    return data;
  }

  async getLabelerView(did: Did): Promise<LabelerView> {
    const { ok, data } = await this.rpc.get("app.bsky.labeler.getServices", {
      params: { dids: [did], detailed: true },
    });

    if (!ok) {
      throw data.error;
    }
    const {
      views: [view],
    } = data;
    return view as LabelerView;
  }

  async *getFollows(actor: ActorIdentifier): AsyncGenerator<Profile> {
    const LIMIT = 100;
    let cursor = "";
    while (true) {
      const { ok, data } = await this.rpc.get("app.bsky.graph.getFollows", {
        params: { actor, limit: LIMIT, cursor },
      });
      if (!ok) {
        throw data.error;
      }

      yield* data.follows;
      if (!data.cursor) {
        break;
      }
      cursor = data.cursor;
    }
  }

  async *getLikes(uri: ResourceUri): AsyncGenerator<Like> {
    const LIMIT = 100;
    let cursor = "";
    while (true) {
      const { ok, data } = await this.rpc.get("app.bsky.feed.getLikes", {
        params: { uri, limit: LIMIT, cursor },
      });
      if (!ok) {
        throw data.error;
      }

      yield* data.likes;
      if (!data.cursor) {
        break;
      }
      cursor = data.cursor;
    }
  }

  async *getLabels(did: Did): AsyncGenerator<string> {
    const LIMIT = 250;
    let cursor = "";
    while (true) {
      const { ok, data } = await this.rpc.get("com.atproto.label.queryLabels", {
        params: {
          sources: [LABELER_DID],
          uriPatterns: [did],
          limit: LIMIT,
          cursor,
        },
      });
      if (!ok) {
        throw data.error;
      }

      for (const label of data.labels) {
        yield label.val;
      }
      if (!data.cursor) {
        break;
      }
      cursor = data.cursor;
    }
  }
}
