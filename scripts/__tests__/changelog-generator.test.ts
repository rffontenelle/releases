import https from "https";
import { EventEmitter } from "events";
import fs from "fs";
import path from "path";
import util from "util";
import deepmerge from "deepmerge";

const readFile = util.promisify(fs.readFile);

import {
  CHANGES_TEMPLATE,
  git,
  fetchCommits,
  generateChangelog,
  getChangeMessage,
  getChangelogDesc,
  getOffsetBaseCommit,
  getOriginalCommit,
  getFirstCommitAfterForkingFromMaster,
  Changes,
  PlatformChanges
} from "../changelog-generator";

if (!process.env.RN_REPO) {
  throw new Error(
    "[!] Specify the path to a checkout of the react-native repo with the `RN_REPO` env variable."
  );
}
const RN_REPO = path.join(process.env.RN_REPO, ".git");

console.warn = () => {};
console.error = () => {};

function requestWithFixtureResponse(fixture: string) {
  const requestEmitter = new EventEmitter();
  const responseEmitter = new EventEmitter();
  (responseEmitter as any).statusCode = 200;
  (responseEmitter as any).headers = { link: 'rel="next"' };
  setImmediate(() => {
    requestEmitter.emit("response", responseEmitter);
    readFile(path.join(__dirname, "__fixtures__", fixture), "utf-8").then(
      data => {
        responseEmitter.emit("data", data);
        responseEmitter.emit("end");
      }
    );
  });
  return requestEmitter;
}

describe(getOriginalCommit, () => {
  it("returns a cherry-picked community commit with the `sha` updated to point to the original in the `master` branch", () => {
    return getOriginalCommit(RN_REPO, {
      sha: "474861f4e7aa0c5314081444edaee48d2faea1b6",
      commit: {
        message: "A community picked commit\n\nDifferential Revision: D17285473"
      },
      author: { login: "janicduplessis" }
    }).then(commit => {
      expect(commit).toEqual({
        sha: "2c1913f0b3d12147654501f7ee43af1d313655d8",
        commit: {
          message:
            "A community picked commit\n\nDifferential Revision: D17285473"
        },
        author: { login: "janicduplessis" }
      });
    });
  });
});

describe(getFirstCommitAfterForkingFromMaster, () => {
  it("returns the SHA of the first commit where its first parent is on the master branch", () => {
    return getFirstCommitAfterForkingFromMaster(RN_REPO, "v0.61.5").then(
      sha => {
        expect(sha).toEqual("bb625e523867d3b8391a76e5aa7c22c081036835");
      }
    );
  });
});

describe(getOffsetBaseCommit, () => {
  it("returns the first commit after forking from `master` when that is not the same as the one for `compare`", () => {
    return getOffsetBaseCommit(RN_REPO, "v0.60.5", "v0.61.0").then(sha => {
      expect(sha).toEqual("9cd88251a3051dc1f3f9348a4395f0baae56f5b5");
    });
  });

  it("returns the resolved input base commit, if both `base` and `compare` resolve to the same first commit after forking from `master`", () => {
    return getOffsetBaseCommit(RN_REPO, "v0.60.5", "v0.60.6").then(sha => {
      expect(sha).toEqual("35300147ca66677f42e8544264be72ac0e9d1b45");
    });
  });
});

describe(getChangeMessage, () => {
  it("formats a changelog entry", () => {
    expect(
      getChangeMessage({
        sha: "abcde123456789",
        commit: {
          message:
            "Some ignored commit message\n\n[iOS] [Fixed] - Some great fixes! (#42)"
        },
        author: { login: "alloy" }
      })
    ).toEqual(
      "- Some great fixes! ([abcde12345](https://github.com/facebook/react-native/commit/abcde123456789) by [@alloy](https://github.com/alloy))"
    );
  });
});

describe("functions that hit GitHub's commits API", () => {
  // The 2nd to last commit in commits-v0.60.5-page-2.json, which is the 59th commit.
  const base = "53e32a47e4062f428f8d714333236cedbe05b482";
  // The first commit in commits-v0.60.5-page-1.json, which is the last chronologically as the
  // GH API returns commits in DESC order.
  const compare = "35300147ca66677f42e8544264be72ac0e9d1b45";

  beforeAll(() => {
    const getMock = jest.fn(uri => {
      if (
        uri.path ===
        `/repos/facebook/react-native/commits?sha=${compare}&page=1`
      ) {
        return requestWithFixtureResponse("commits-v0.60.5-page-1.json");
      } else if (
        uri.path ===
        `/repos/facebook/react-native/commits?sha=${compare}&page=2`
      ) {
        return requestWithFixtureResponse("commits-v0.60.5-page-2.json");
      } else {
        throw new Error(`Unexpected request: ${uri.path}`);
      }
    });
    Object.defineProperty(https, "get", { value: getMock });
  });

  describe(fetchCommits, () => {
    it("paginates back from `compare` to `base`", () => {
      return fetchCommits("authn-token", base, compare).then(commits => {
        expect(commits.length).toEqual(59);
        expect(commits[0].sha).toEqual(
          "35300147ca66677f42e8544264be72ac0e9d1b45"
        );
        expect(commits[30].sha).toEqual(
          "99bc31cfa609e838779c29343684365a2ed6169f"
        );
      });
    });
  });

  describe(generateChangelog, () => {
    it("fetches commits, filters them, and generates markdown", () => {
      return generateChangelog({
        base,
        compare,
        token: "authn-token",
        gitDir: RN_REPO,
        maxWorkers: 10,
        existingChangelogData:
          "- Bla bla bla ([ffdf3f2](https://github.com/facebook/react-native/commit/ffdf3f2)"
      }).then(changelog => {
        expect(changelog).toMatchSnapshot();
      });
    });
  });
});

function getCommitMessage(sha: string) {
  return git(RN_REPO, "log", "--format=%B", "-n", "1", sha);
}

type PartialChanges = {
  [K in keyof Changes]?: Partial<PlatformChanges>
}

describe("formatting and attribution regression tests", () => {
  const cases: Array<[string, PartialChanges]> = [
    [
      "d8fa1206c3fecd494b0f6abb63c66488e6ced5e0",
      {
        fixed: {
          android: ["Fix indexed RAM bundle"]
        }
      }
    ],
    [
      "d37baa78f11f36aa5fb84307cc29ebe2bf444a33",
      {
        changed: {
          general: [
            "Split NativeImageLoader into NativeImageLoaderAndroid and NativeImageLoaderIOS"
          ]
        }
      }
    ]
  ];
  test.each(cases)("%s", (sha, expected) => {
    return getCommitMessage(sha).then(message => {
      const commits = [{ sha, commit: { message } }];
      const result = getChangelogDesc(commits, true, true);
      expect(result).toEqual(deepmerge(CHANGES_TEMPLATE, expected));
    });
  });
});