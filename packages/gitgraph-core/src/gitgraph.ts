import Branch, {
  BranchOptions,
  BranchCommitDefaultOptions,
  DELETED_BRANCH_NAME,
  createDeletedBranch,
} from "./branch";
import Commit, { CommitRenderOptions } from "./commit";
import { createGraphRows } from "./graph-rows";
import { GraphColumns } from "./graph-columns";
import {
  Template,
  TemplateName,
  CommitStyleOptions,
  BranchStyleOptions,
  getTemplate,
} from "./template";
import Refs from "./refs";
import BranchesPathsCalculator, { BranchesPaths } from "./branches-paths";
import { booleanOptionOr, numberOptionOr } from "./utils";
import { Orientation } from "./orientation";
import { GitgraphUserApi } from "./gitgraph-user-api";

export enum Mode {
  Compact = "compact",
}

export interface GitgraphOptions {
  template?: TemplateName | Template;
  orientation?: Orientation;
  reverseArrow?: boolean;
  initCommitOffsetX?: number;
  initCommitOffsetY?: number;
  mode?: Mode;
  author?: string;
  commitMessage?: string;
}

export interface RenderedData<TNode> {
  commits: Array<Commit<TNode>>;
  branchesPaths: BranchesPaths<TNode>;
  commitMessagesX: number;
}

export interface GitgraphCommitOptions<TNode = SVGElement>
  extends CommitRenderOptions<TNode> {
  author?: string;
  subject?: string;
  body?: string;
  hash?: string;
  style?: CommitStyleOptions;
  dotText?: string;
  tag?: string;
  onClick?: (commit: Commit<TNode>) => void;
  onMessageClick?: (commit: Commit<TNode>) => void;
  onMouseOver?: (commit: Commit<TNode>) => void;
  onMouseOut?: (commit: Commit<TNode>) => void;
}

export interface GitgraphBranchOptions<TNode> {
  /**
   * Branch name
   */
  name: string;
  /**
   * Default options for commits
   */
  commitDefaultOptions?: BranchCommitDefaultOptions<TNode>;
  /**
   * Branch style
   */
  style?: BranchStyleOptions;
}

export class GitgraphCore<TNode = SVGElement> {
  public orientation?: Orientation;
  public isVertical: boolean;
  public reverseArrow: boolean;
  public initCommitOffsetX: number;
  public initCommitOffsetY: number;
  public mode?: Mode;
  public author: string;
  public commitMessage: string;
  public template: Template;

  public refs = new Refs();
  public tags = new Refs();
  public commits: Array<Commit<TNode>> = [];
  public branches: Map<Branch["name"], Branch<TNode>> = new Map();
  public currentBranch: Branch<TNode>;

  private listeners: Array<() => void> = [];

  constructor(options: GitgraphOptions = {}) {
    this.template = getTemplate(options.template);

    // Set a default `master` branch
    this.currentBranch = this.branch("master");

    // Set all options with default values
    this.orientation = options.orientation;
    this.isVertical = [
      undefined, // default value = Vertical
      Orientation.VerticalReverse,
    ].includes(this.orientation);
    this.reverseArrow = booleanOptionOr(options.reverseArrow, false);
    this.initCommitOffsetX = numberOptionOr(
      options.initCommitOffsetX,
      0,
    ) as number;
    this.initCommitOffsetY = numberOptionOr(
      options.initCommitOffsetY,
      0,
    ) as number;
    this.mode = options.mode;
    this.author = options.author || "Sergio Flores <saxo-guy@epic.com>";
    this.commitMessage =
      options.commitMessage || "He doesn't like George Michael! Boooo!";
  }

  /**
   * Return all data required for rendering.
   * Rendering libraries will use this to implement their rendering strategy.
   */
  public getRenderedData(): RenderedData<TNode> {
    const commits = this.computeRenderedCommits();
    const branchesPaths = this.computeRenderedBranchesPaths(commits);
    const commitMessagesX = this.computeCommitMessagesX(branchesPaths);

    this.computeBranchesColor(branchesPaths);

    return { commits, branchesPaths, commitMessagesX };
  }

  /**
   * Add a change listener.
   * It will be called any time the graph have changed (commit, merge…).
   *
   * @param listener A callback to be invoked on every change.
   * @returns A function to remove this change listener.
   */
  public subscribe(listener: () => void): () => void {
    this.listeners.push(listener);

    let isSubscribed = true;

    return () => {
      if (!isSubscribed) return;
      isSubscribed = false;
      const index = this.listeners.indexOf(listener);
      this.listeners.splice(index, 1);
    };
  }

  /**
   * Return the API to manipulate Gitgraph as a user.
   * Rendering library should give that API to their consumer.
   */
  public getUserApi(): GitgraphUserApi<TNode> {
    return new GitgraphUserApi(this, () => this.next());
  }

  // ===
  // 👆 Public methods above are for rendering libs.
  // 👇 Public methods below are for the end-user.
  // ===

  /**
   * Create a new branch. (as `git branch`)
   *
   * @param options options of the branch
   */
  public branch(options: GitgraphBranchOptions<TNode>): Branch<TNode>;
  /**
   * Create a new branch. (as `git branch`)
   *
   * @param name name of the created branch
   */
  public branch(name: string): Branch<TNode>;
  public branch(args: any): Branch<TNode> {
    const parentCommitHash = this.refs.getCommit("HEAD");
    let options: BranchOptions<TNode> = {
      gitgraph: this,
      name: "",
      parentCommitHash,
      style: this.template.branch,
      onGraphUpdate: () => this.next(),
    };
    if (typeof args === "string") {
      options.name = args;
    } else {
      options = { ...options, ...args };
    }
    const branch = new Branch<TNode>(options);
    this.branches.set(branch.name, branch);

    return branch;
  }

  /**
   * Tag a specific commit. (as `git tag`)
   *
   * @param name Name of the tag
   * @param ref Commit or branch name or commit hash
   */
  public tag(
    name: string,
    ref?: Commit<TNode> | Commit["hash"] | Branch["name"],
  ): GitgraphCore<TNode> {
    if (!ref) {
      const head = this.refs.getCommit("HEAD");
      if (!head) return this;

      ref = head;
    }

    if (typeof ref !== "string") {
      // `ref` is a `Commit`
      this.tags.set(name, ref.hash);
      this.next();
      return this;
    }

    let commitHash;
    if (this.refs.hasCommit(ref)) {
      // `ref` is a `Commit["hash"]`
      commitHash = ref;
    }

    if (this.refs.hasName(ref)) {
      // `ref` is a `Branch["name"]`
      commitHash = this.refs.getCommit(ref);
    }

    if (!commitHash) {
      throw new Error(`The ref "${ref}" does not exist`);
    }

    this.tags.set(name, commitHash);
    this.next();
    return this;
  }

  /**
   * Tell each listener something new happened.
   * E.g. a rendering library will know it needs to re-render the graph.
   */
  private next() {
    this.listeners.forEach((listener) => listener());
  }

  /**
   * Return commits with data for rendering.
   */
  private computeRenderedCommits(): Array<Commit<TNode>> {
    const commitsWithBranches = this.commits.map((commit) =>
      this.withBranches(commit),
    );

    const columns = new GraphColumns<TNode>(commitsWithBranches);

    return commitsWithBranches
      .map((commit) => commit.setRefs(this.refs))
      .map((commit) => commit.setTags(this.tags))
      .map((commit) => this.withPosition(commit, columns))
      .map((commit) => this.setDefaultColor(commit, columns));
  }

  /**
   * Return branches paths with all data required for rendering.
   *
   * @param commits List of commits with rendering data computed
   */
  private computeRenderedBranchesPaths(
    commits: Array<Commit<TNode>>,
  ): BranchesPaths<TNode> {
    return new BranchesPathsCalculator<TNode>(
      commits,
      this.branches,
      this.template.commit.spacing,
      this.isVertical,
      () => createDeletedBranch(this, this.template.branch, () => this.next()),
    ).execute();
  }

  /**
   * Set branches colors based on branches paths.
   *
   * @param branchesPaths Branches paths to be rendered
   */
  private computeBranchesColor(branchesPaths: BranchesPaths<TNode>): void {
    Array.from(branchesPaths).forEach(([branch], i) => {
      const defaultColor = this.template.colors[
        i % this.template.colors.length
      ];
      branch.computedColor = branch.style.color || defaultColor;
    });
  }

  /**
   * Return commit messages X position for rendering.
   *
   * @param branchesPaths Branches paths to be rendered
   */
  private computeCommitMessagesX(branchesPaths: BranchesPaths<TNode>): number {
    const numberOfColumns = Array.from(branchesPaths).length;
    return numberOfColumns * this.template.branch.spacing;
  }

  /**
   * Add `branches` property to commit.
   *
   * @param commit Commit
   */
  private withBranches(commit: Commit<TNode>): Commit<TNode> {
    const branches = this.getBranches();

    let commitBranches = Array.from(
      (branches.get(commit.hash) || new Set()).values(),
    );

    if (commitBranches.length === 0) {
      // No branch => branch has been deleted.
      commitBranches = [DELETED_BRANCH_NAME];
    }

    return commit.setBranches(commitBranches);
  }

  /**
   * Get all branches from current commits.
   */
  private getBranches(): Map<Commit["hash"], Set<Branch["name"]>> {
    const result = new Map<Commit["hash"], Set<Branch["name"]>>();

    const queue: Array<Commit["hash"]> = [];
    const branches = this.refs.getAllNames().filter((name) => name !== "HEAD");
    branches.forEach((branch) => {
      const commitHash = this.refs.getCommit(branch);
      if (commitHash) {
        queue.push(commitHash);
      }

      while (queue.length > 0) {
        const currentHash = queue.pop() as Commit["hash"];
        const current = this.commits.find(
          ({ hash }) => hash === currentHash,
        ) as Commit<TNode>;
        const prevBranches =
          result.get(currentHash) || new Set<Branch["name"]>();
        prevBranches.add(branch);
        result.set(currentHash, prevBranches);
        if (current.parents.length > 0) {
          queue.push(current.parents[0]);
        }
      }
    });

    return result;
  }

  /**
   * Add position to given commit.
   *
   * @param commit A commit
   */
  private withPosition(
    commit: Commit<TNode>,
    columns: GraphColumns<TNode>,
  ): Commit<TNode> {
    const rows = createGraphRows(this.mode, this.commits);
    const row = rows.getRowOf(commit.hash);
    const maxRow = rows.getMaxRow();
    const column = columns.get(commit.branchToDisplay);

    switch (this.orientation) {
      default:
        return commit.setPosition({
          x: this.initCommitOffsetX + this.template.branch.spacing * column,
          y:
            this.initCommitOffsetY +
            this.template.commit.spacing * (maxRow - row),
        });

      case Orientation.VerticalReverse:
        return commit.setPosition({
          x: this.initCommitOffsetX + this.template.branch.spacing * column,
          y: this.initCommitOffsetY + this.template.commit.spacing * row,
        });

      case Orientation.Horizontal:
        return commit.setPosition({
          x: this.initCommitOffsetX + this.template.commit.spacing * row,
          y: this.initCommitOffsetY + this.template.branch.spacing * column,
        });

      case Orientation.HorizontalReverse:
        return commit.setPosition({
          x:
            this.initCommitOffsetX +
            this.template.commit.spacing * (maxRow - row),
          y: this.initCommitOffsetY + this.template.branch.spacing * column,
        });
    }
  }

  /**
   * Set default color to one commit.
   *
   * @param commit One commit
   */
  private setDefaultColor(
    commit: Commit<TNode>,
    columns: GraphColumns<TNode>,
  ): Commit<TNode> {
    const column = columns.get(commit.branchToDisplay);
    const defaultColor = this.template.colors[
      column % this.template.colors.length
    ];

    return commit.withDefaultColor(defaultColor);
  }
}

export default GitgraphCore;
