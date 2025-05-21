import type {
  ProfileView,
  ProfileViewDetailed,
} from "@atcute/bluesky/types/app/actor/defs";
import type { Like as OriginalLike } from "@atcute/bluesky/types/app/feed/getLikes";
import type { PostView } from "@atcute/bluesky/types/app/feed/defs";
import type { ActorIdentifier, Did, ResourceUri } from "@atcute/lexicons";
import { Endpoint, schema } from "@rest-hooks/endpoint";
import { Client } from "./bluesky";
import {
  LabelerPolicies,
  LabelerViewDetailed,
} from "@atcute/bluesky/types/app/labeler/defs";

export class Profile {
  public did: Did;
  public handle: string;
  public displayName: string | undefined;
  public avatar: string | undefined;

  constructor(profileView: ProfileView | ProfileViewDetailed) {
    this.did = profileView.did;
    this.handle = profileView.handle;
    this.displayName = profileView.displayName;
    this.avatar = profileView.avatar;
  }

  pk() {
    return this.did;
  }
}

export class Post {
  public uri: ResourceUri;
  public cid: string;
  public likeCount: number | undefined;
  public viewer: { like?: ResourceUri | undefined } | undefined;

  constructor(postView: PostView) {
    this.uri = postView.uri;
    this.cid = postView.cid;
    this.likeCount = postView.likeCount;
    this.viewer = postView.viewer;
  }

  pk() {
    return this.uri;
  }
}

export class Like {
  public actor: Profile;

  constructor(like: OriginalLike) {
    this.actor = new Profile(like.actor);
  }

  pk() {
    return this.actor.did;
  }
}

export class LabelerView {
  public uri: ResourceUri;
  public policies: LabelerPolicies;

  constructor(labelerViewDetailed: LabelerViewDetailed) {
    this.uri = labelerViewDetailed.uri;
    this.policies = labelerViewDetailed.policies;
  }

  pk() {
    return this.uri;
  }
}

export const PostEntity = schema.Entity(Post, {
  key: "Post",
});

export const ProfileEntity = schema.Entity(Profile, {
  key: "Profile",
});

export const LikeEntity = schema.Entity(Like, {
  key: "Like",
});

export const LabelerViewEntity = schema.Entity(LabelerView, {
  key: "LabelerView",
});

export const getAuthorPosts = new Endpoint(
  async function getAuthorPosts({
    client,
    actor,
  }: {
    client: Client;
    actor: ActorIdentifier;
  }) {
    const posts = [];
    for await (const postView of client.getAuthorPosts(actor)) {
      posts.push(new Post(postView));
    }
    return posts;
  },
  {
    schema: [PostEntity],
  }
);

export const getProfile = new Endpoint(
  async function getProfile({ client, did }: { client: Client; did: Did }) {
    return new Profile(await client.getProfile(did));
  },
  {
    schema: ProfileEntity,
  }
);

export const getLikes = new Endpoint(
  async function getLikes({
    client,
    uri,
  }: {
    client: Client;
    uri: ResourceUri;
  }) {
    const likes = [];
    for await (const like of client.getLikes(uri)) {
      likes.push(new Like(like));
    }
    return likes;
  },
  {
    schema: [LikeEntity],
  }
);

export const getFollows = new Endpoint(
  async function getFollows({
    client,
    actor,
  }: {
    client: Client;
    actor: ActorIdentifier;
  }) {
    const follows = [];
    for await (const follow of client.getFollows(actor)) {
      follows.push(new Profile(follow));
    }
    return follows;
  },
  {
    schema: [ProfileEntity],
  }
);

export const getLabelerView = new Endpoint(
  async function getLabelerView({ client, did }: { client: Client; did: Did }) {
    return new LabelerView(await client.getLabelerView(did));
  },
  {
    schema: LabelerViewEntity,
  }
);
