import type {} from "@atcute/atproto";
import { AppBskyFeedLike } from "@atcute/bluesky";
import type {
  ProfileView,
  ProfileViewDetailed,
} from "@atcute/bluesky/types/app/actor/defs";
import type {
  PostView,
  ThreadViewPost,
} from "@atcute/bluesky/types/app/feed/defs";
import type { Like } from "@atcute/bluesky/types/app/feed/getLikes";
import type { LabelerViewDetailed } from "@atcute/bluesky/types/app/labeler/defs";
import {
  Client as AtcuteClient,
  buildFetchHandler,
  simpleFetchHandler,
} from "@atcute/client";
import type {
  ActorIdentifier,
  Cid,
  Did,
  Nsid,
  ResourceUri,
} from "@atcute/lexicons";
import { OAuthUserAgent, Session } from "@atcute/oauth-browser-client";
import { LABELER_DID } from "./config";

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

  async getProfile(actor: ActorIdentifier): Promise<ProfileViewDetailed> {
    const { ok, data } = await this.rpc.get("app.bsky.actor.getProfile", {
      params: { actor },
    });
    if (!ok) {
      throw data.error;
    }
    return data;
  }

  async getPostThread(uri: ResourceUri): Promise<ThreadViewPost> {
    const { ok, data } = await this.rpc.get("app.bsky.feed.getPostThread", {
      params: { uri, depth: 0, parentHeight: 0 },
    });
    if (!ok) {
      throw data.error;
    }
    if (data.thread.$type != "app.bsky.feed.defs#threadViewPost") {
      throw data;
    }
    return data.thread;
  }

  async getLabelerView(did: Did): Promise<LabelerViewDetailed> {
    const { ok, data } = await this.rpc.get("app.bsky.labeler.getServices", {
      params: { dids: [did], detailed: true },
    });

    if (!ok) {
      throw data.error;
    }
    const {
      views: [view],
    } = data;
    return view as LabelerViewDetailed;
  }

  async *getFollows(actor: ActorIdentifier): AsyncGenerator<ProfileView> {
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

  async unlike(uri: ResourceUri) {
    const [repo, collection, rkey] = uri.replace(/^at:\/\//, "").split("/");

    const { ok, data } = await this.rpc.post("com.atproto.repo.deleteRecord", {
      input: {
        collection: collection as Nsid,
        repo: repo as Did,
        rkey,
      },
    });
    if (!ok) {
      throw data.error;
    }
  }

  async like(uri: ResourceUri, cid: Cid) {
    if (this.did == null) {
      return;
    }

    const { ok, data } = await this.rpc.post("com.atproto.repo.createRecord", {
      input: {
        collection: "app.bsky.feed.like",
        repo: this.did,
        record: {
          $type: "app.bsky.feed.like",
          subject: {
            uri,
            cid,
          },
          createdAt: new Date().toISOString(),
        } satisfies AppBskyFeedLike.Main,
      },
    });
    if (!ok) {
      throw data.error;
    }

    return data.uri;
  }
}
