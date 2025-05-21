import type {
  ProfileView,
  ProfileViewDetailed,
} from "@atcute/bluesky/types/app/actor/defs";
import type { PostView } from "@atcute/bluesky/types/app/feed/defs";
import type { Like as OriginalLike } from "@atcute/bluesky/types/app/feed/getLikes";
import {
  LabelerPolicies,
  LabelerViewDetailed,
} from "@atcute/bluesky/types/app/labeler/defs";
import type { ActorIdentifier, Did, ResourceUri } from "@atcute/lexicons";
import { Endpoint, schema } from "@data-client/endpoint";
import { useClient } from "./hooks";

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

export function useGetAuthorPosts() {
  const client = useClient();

  return new Endpoint(
    async function getAuthorPosts({ actor }: { actor: ActorIdentifier }) {
      const posts = [];
      for await (const postView of client.getAuthorPosts(actor)) {
        posts.push(new Post(postView));
      }
      return posts;
    },
    {
      schema: new schema.Collection([PostEntity]),
    }
  );
}

export function useGetProfile() {
  const client = useClient();

  return new Endpoint(
    async function getProfile({ did }: { did: Did }) {
      return new Profile(await client.getProfile(did));
    },
    {
      schema: ProfileEntity,
    }
  );
}

export function useGetLikes() {
  const client = useClient();

  return new Endpoint(
    async function getLikes({ uri }: { uri: ResourceUri }) {
      const likes = [];
      for await (const like of client.getLikes(uri)) {
        likes.push(new Like(like));
      }
      return likes;
    },
    {
      schema: new schema.Collection([LikeEntity]),
    }
  );
}

export function useGetFollows() {
  const client = useClient();

  return new Endpoint(
    async function getFollows({ actor }: { actor: ActorIdentifier }) {
      const follows = [];
      for await (const follow of client.getFollows(actor)) {
        follows.push(new Profile(follow));
      }
      return follows;
    },
    {
      schema: new schema.Collection([ProfileEntity]),
    }
  );
}

export function useGetLabelerView() {
  const client = useClient();

  return new Endpoint(
    async function getLabelerView({ did }: { did: Did }) {
      return new LabelerView(await client.getLabelerView(did));
    },
    {
      schema: LabelerViewEntity,
    }
  );
}
