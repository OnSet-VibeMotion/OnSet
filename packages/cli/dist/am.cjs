"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// ../../node_modules/yaml/dist/nodes/identity.js
var require_identity = __commonJS({
  "../../node_modules/yaml/dist/nodes/identity.js"(exports2) {
    "use strict";
    var ALIAS = /* @__PURE__ */ Symbol.for("yaml.alias");
    var DOC = /* @__PURE__ */ Symbol.for("yaml.document");
    var MAP = /* @__PURE__ */ Symbol.for("yaml.map");
    var PAIR = /* @__PURE__ */ Symbol.for("yaml.pair");
    var SCALAR = /* @__PURE__ */ Symbol.for("yaml.scalar");
    var SEQ = /* @__PURE__ */ Symbol.for("yaml.seq");
    var NODE_TYPE = /* @__PURE__ */ Symbol.for("yaml.node.type");
    var isAlias2 = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === ALIAS;
    var isDocument = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === DOC;
    var isMap5 = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === MAP;
    var isPair = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === PAIR;
    var isScalar5 = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === SCALAR;
    var isSeq2 = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === SEQ;
    function isCollection(node) {
      if (node && typeof node === "object")
        switch (node[NODE_TYPE]) {
          case MAP:
          case SEQ:
            return true;
        }
      return false;
    }
    function isNode(node) {
      if (node && typeof node === "object")
        switch (node[NODE_TYPE]) {
          case ALIAS:
          case MAP:
          case SCALAR:
          case SEQ:
            return true;
        }
      return false;
    }
    var hasAnchor = (node) => (isScalar5(node) || isCollection(node)) && !!node.anchor;
    exports2.ALIAS = ALIAS;
    exports2.DOC = DOC;
    exports2.MAP = MAP;
    exports2.NODE_TYPE = NODE_TYPE;
    exports2.PAIR = PAIR;
    exports2.SCALAR = SCALAR;
    exports2.SEQ = SEQ;
    exports2.hasAnchor = hasAnchor;
    exports2.isAlias = isAlias2;
    exports2.isCollection = isCollection;
    exports2.isDocument = isDocument;
    exports2.isMap = isMap5;
    exports2.isNode = isNode;
    exports2.isPair = isPair;
    exports2.isScalar = isScalar5;
    exports2.isSeq = isSeq2;
  }
});

// ../../node_modules/yaml/dist/visit.js
var require_visit = __commonJS({
  "../../node_modules/yaml/dist/visit.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var BREAK = /* @__PURE__ */ Symbol("break visit");
    var SKIP = /* @__PURE__ */ Symbol("skip children");
    var REMOVE = /* @__PURE__ */ Symbol("remove node");
    function visit(node, visitor) {
      const visitor_ = initVisitor(visitor);
      if (identity.isDocument(node)) {
        const cd = visit_(null, node.contents, visitor_, Object.freeze([node]));
        if (cd === REMOVE)
          node.contents = null;
      } else
        visit_(null, node, visitor_, Object.freeze([]));
    }
    visit.BREAK = BREAK;
    visit.SKIP = SKIP;
    visit.REMOVE = REMOVE;
    function visit_(key, node, visitor, path27) {
      const ctrl = callVisitor(key, node, visitor, path27);
      if (identity.isNode(ctrl) || identity.isPair(ctrl)) {
        replaceNode(key, path27, ctrl);
        return visit_(key, ctrl, visitor, path27);
      }
      if (typeof ctrl !== "symbol") {
        if (identity.isCollection(node)) {
          path27 = Object.freeze(path27.concat(node));
          for (let i = 0; i < node.items.length; ++i) {
            const ci2 = visit_(i, node.items[i], visitor, path27);
            if (typeof ci2 === "number")
              i = ci2 - 1;
            else if (ci2 === BREAK)
              return BREAK;
            else if (ci2 === REMOVE) {
              node.items.splice(i, 1);
              i -= 1;
            }
          }
        } else if (identity.isPair(node)) {
          path27 = Object.freeze(path27.concat(node));
          const ck = visit_("key", node.key, visitor, path27);
          if (ck === BREAK)
            return BREAK;
          else if (ck === REMOVE)
            node.key = null;
          const cv = visit_("value", node.value, visitor, path27);
          if (cv === BREAK)
            return BREAK;
          else if (cv === REMOVE)
            node.value = null;
        }
      }
      return ctrl;
    }
    async function visitAsync(node, visitor) {
      const visitor_ = initVisitor(visitor);
      if (identity.isDocument(node)) {
        const cd = await visitAsync_(null, node.contents, visitor_, Object.freeze([node]));
        if (cd === REMOVE)
          node.contents = null;
      } else
        await visitAsync_(null, node, visitor_, Object.freeze([]));
    }
    visitAsync.BREAK = BREAK;
    visitAsync.SKIP = SKIP;
    visitAsync.REMOVE = REMOVE;
    async function visitAsync_(key, node, visitor, path27) {
      const ctrl = await callVisitor(key, node, visitor, path27);
      if (identity.isNode(ctrl) || identity.isPair(ctrl)) {
        replaceNode(key, path27, ctrl);
        return visitAsync_(key, ctrl, visitor, path27);
      }
      if (typeof ctrl !== "symbol") {
        if (identity.isCollection(node)) {
          path27 = Object.freeze(path27.concat(node));
          for (let i = 0; i < node.items.length; ++i) {
            const ci2 = await visitAsync_(i, node.items[i], visitor, path27);
            if (typeof ci2 === "number")
              i = ci2 - 1;
            else if (ci2 === BREAK)
              return BREAK;
            else if (ci2 === REMOVE) {
              node.items.splice(i, 1);
              i -= 1;
            }
          }
        } else if (identity.isPair(node)) {
          path27 = Object.freeze(path27.concat(node));
          const ck = await visitAsync_("key", node.key, visitor, path27);
          if (ck === BREAK)
            return BREAK;
          else if (ck === REMOVE)
            node.key = null;
          const cv = await visitAsync_("value", node.value, visitor, path27);
          if (cv === BREAK)
            return BREAK;
          else if (cv === REMOVE)
            node.value = null;
        }
      }
      return ctrl;
    }
    function initVisitor(visitor) {
      if (typeof visitor === "object" && (visitor.Collection || visitor.Node || visitor.Value)) {
        return Object.assign({
          Alias: visitor.Node,
          Map: visitor.Node,
          Scalar: visitor.Node,
          Seq: visitor.Node
        }, visitor.Value && {
          Map: visitor.Value,
          Scalar: visitor.Value,
          Seq: visitor.Value
        }, visitor.Collection && {
          Map: visitor.Collection,
          Seq: visitor.Collection
        }, visitor);
      }
      return visitor;
    }
    function callVisitor(key, node, visitor, path27) {
      if (typeof visitor === "function")
        return visitor(key, node, path27);
      if (identity.isMap(node))
        return visitor.Map?.(key, node, path27);
      if (identity.isSeq(node))
        return visitor.Seq?.(key, node, path27);
      if (identity.isPair(node))
        return visitor.Pair?.(key, node, path27);
      if (identity.isScalar(node))
        return visitor.Scalar?.(key, node, path27);
      if (identity.isAlias(node))
        return visitor.Alias?.(key, node, path27);
      return void 0;
    }
    function replaceNode(key, path27, node) {
      const parent = path27[path27.length - 1];
      if (identity.isCollection(parent)) {
        parent.items[key] = node;
      } else if (identity.isPair(parent)) {
        if (key === "key")
          parent.key = node;
        else
          parent.value = node;
      } else if (identity.isDocument(parent)) {
        parent.contents = node;
      } else {
        const pt = identity.isAlias(parent) ? "alias" : "scalar";
        throw new Error(`Cannot replace node with ${pt} parent`);
      }
    }
    exports2.visit = visit;
    exports2.visitAsync = visitAsync;
  }
});

// ../../node_modules/yaml/dist/doc/directives.js
var require_directives = __commonJS({
  "../../node_modules/yaml/dist/doc/directives.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var visit = require_visit();
    var escapeChars = {
      "!": "%21",
      ",": "%2C",
      "[": "%5B",
      "]": "%5D",
      "{": "%7B",
      "}": "%7D"
    };
    var escapeTagName = (tn) => tn.replace(/[!,[\]{}]/g, (ch) => escapeChars[ch]);
    var Directives = class _Directives {
      constructor(yaml, tags) {
        this.docStart = null;
        this.docEnd = false;
        this.yaml = Object.assign({}, _Directives.defaultYaml, yaml);
        this.tags = Object.assign({}, _Directives.defaultTags, tags);
      }
      clone() {
        const copy = new _Directives(this.yaml, this.tags);
        copy.docStart = this.docStart;
        return copy;
      }
      /**
       * During parsing, get a Directives instance for the current document and
       * update the stream state according to the current version's spec.
       */
      atDocument() {
        const res = new _Directives(this.yaml, this.tags);
        switch (this.yaml.version) {
          case "1.1":
            this.atNextDocument = true;
            break;
          case "1.2":
            this.atNextDocument = false;
            this.yaml = {
              explicit: _Directives.defaultYaml.explicit,
              version: "1.2"
            };
            this.tags = Object.assign({}, _Directives.defaultTags);
            break;
        }
        return res;
      }
      /**
       * @param onError - May be called even if the action was successful
       * @returns `true` on success
       */
      add(line2, onError) {
        if (this.atNextDocument) {
          this.yaml = { explicit: _Directives.defaultYaml.explicit, version: "1.1" };
          this.tags = Object.assign({}, _Directives.defaultTags);
          this.atNextDocument = false;
        }
        const parts = line2.trim().split(/[ \t]+/);
        const name = parts.shift();
        switch (name) {
          case "%TAG": {
            if (parts.length !== 2) {
              onError(0, "%TAG directive should contain exactly two parts");
              if (parts.length < 2)
                return false;
            }
            const [handle, prefix] = parts;
            this.tags[handle] = prefix;
            return true;
          }
          case "%YAML": {
            this.yaml.explicit = true;
            if (parts.length !== 1) {
              onError(0, "%YAML directive should contain exactly one part");
              return false;
            }
            const [version] = parts;
            if (version === "1.1" || version === "1.2") {
              this.yaml.version = version;
              return true;
            } else {
              const isValid = /^\d+\.\d+$/.test(version);
              onError(6, `Unsupported YAML version ${version}`, isValid);
              return false;
            }
          }
          default:
            onError(0, `Unknown directive ${name}`, true);
            return false;
        }
      }
      /**
       * Resolves a tag, matching handles to those defined in %TAG directives.
       *
       * @returns Resolved tag, which may also be the non-specific tag `'!'` or a
       *   `'!local'` tag, or `null` if unresolvable.
       */
      tagName(source, onError) {
        if (source === "!")
          return "!";
        if (source[0] !== "!") {
          onError(`Not a valid tag: ${source}`);
          return null;
        }
        if (source[1] === "<") {
          const verbatim = source.slice(2, -1);
          if (verbatim === "!" || verbatim === "!!") {
            onError(`Verbatim tags aren't resolved, so ${source} is invalid.`);
            return null;
          }
          if (source[source.length - 1] !== ">")
            onError("Verbatim tags must end with a >");
          return verbatim;
        }
        const [, handle, suffix] = source.match(/^(.*!)([^!]*)$/s);
        if (!suffix)
          onError(`The ${source} tag has no suffix`);
        const prefix = this.tags[handle];
        if (prefix) {
          try {
            return prefix + decodeURIComponent(suffix);
          } catch (error) {
            onError(String(error));
            return null;
          }
        }
        if (handle === "!")
          return source;
        onError(`Could not resolve tag: ${source}`);
        return null;
      }
      /**
       * Given a fully resolved tag, returns its printable string form,
       * taking into account current tag prefixes and defaults.
       */
      tagString(tag) {
        for (const [handle, prefix] of Object.entries(this.tags)) {
          if (tag.startsWith(prefix))
            return handle + escapeTagName(tag.substring(prefix.length));
        }
        return tag[0] === "!" ? tag : `!<${tag}>`;
      }
      toString(doc) {
        const lines = this.yaml.explicit ? [`%YAML ${this.yaml.version || "1.2"}`] : [];
        const tagEntries = Object.entries(this.tags);
        let tagNames;
        if (doc && tagEntries.length > 0 && identity.isNode(doc.contents)) {
          const tags = {};
          visit.visit(doc.contents, (_key, node) => {
            if (identity.isNode(node) && node.tag)
              tags[node.tag] = true;
          });
          tagNames = Object.keys(tags);
        } else
          tagNames = [];
        for (const [handle, prefix] of tagEntries) {
          if (handle === "!!" && prefix === "tag:yaml.org,2002:")
            continue;
          if (!doc || tagNames.some((tn) => tn.startsWith(prefix)))
            lines.push(`%TAG ${handle} ${prefix}`);
        }
        return lines.join("\n");
      }
    };
    Directives.defaultYaml = { explicit: false, version: "1.2" };
    Directives.defaultTags = { "!!": "tag:yaml.org,2002:" };
    exports2.Directives = Directives;
  }
});

// ../../node_modules/yaml/dist/doc/anchors.js
var require_anchors = __commonJS({
  "../../node_modules/yaml/dist/doc/anchors.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var visit = require_visit();
    function anchorIsValid(anchor) {
      if (/[\x00-\x19\s,[\]{}]/.test(anchor)) {
        const sa = JSON.stringify(anchor);
        const msg = `Anchor must not contain whitespace or control characters: ${sa}`;
        throw new Error(msg);
      }
      return true;
    }
    function anchorNames(root) {
      const anchors = /* @__PURE__ */ new Set();
      visit.visit(root, {
        Value(_key, node) {
          if (node.anchor)
            anchors.add(node.anchor);
        }
      });
      return anchors;
    }
    function findNewAnchor(prefix, exclude) {
      for (let i = 1; true; ++i) {
        const name = `${prefix}${i}`;
        if (!exclude.has(name))
          return name;
      }
    }
    function createNodeAnchors(doc, prefix) {
      const aliasObjects = [];
      const sourceObjects = /* @__PURE__ */ new Map();
      let prevAnchors = null;
      return {
        onAnchor: (source) => {
          aliasObjects.push(source);
          prevAnchors ?? (prevAnchors = anchorNames(doc));
          const anchor = findNewAnchor(prefix, prevAnchors);
          prevAnchors.add(anchor);
          return anchor;
        },
        /**
         * With circular references, the source node is only resolved after all
         * of its child nodes are. This is why anchors are set only after all of
         * the nodes have been created.
         */
        setAnchors: () => {
          for (const source of aliasObjects) {
            const ref2 = sourceObjects.get(source);
            if (typeof ref2 === "object" && ref2.anchor && (identity.isScalar(ref2.node) || identity.isCollection(ref2.node))) {
              ref2.node.anchor = ref2.anchor;
            } else {
              const error = new Error("Failed to resolve repeated object (this should not happen)");
              error.source = source;
              throw error;
            }
          }
        },
        sourceObjects
      };
    }
    exports2.anchorIsValid = anchorIsValid;
    exports2.anchorNames = anchorNames;
    exports2.createNodeAnchors = createNodeAnchors;
    exports2.findNewAnchor = findNewAnchor;
  }
});

// ../../node_modules/yaml/dist/doc/applyReviver.js
var require_applyReviver = __commonJS({
  "../../node_modules/yaml/dist/doc/applyReviver.js"(exports2) {
    "use strict";
    function applyReviver(reviver, obj, key, val) {
      if (val && typeof val === "object") {
        if (Array.isArray(val)) {
          for (let i = 0, len = val.length; i < len; ++i) {
            const v0 = val[i];
            const v1 = applyReviver(reviver, val, String(i), v0);
            if (v1 === void 0)
              delete val[i];
            else if (v1 !== v0)
              val[i] = v1;
          }
        } else if (val instanceof Map) {
          for (const k of Array.from(val.keys())) {
            const v0 = val.get(k);
            const v1 = applyReviver(reviver, val, k, v0);
            if (v1 === void 0)
              val.delete(k);
            else if (v1 !== v0)
              val.set(k, v1);
          }
        } else if (val instanceof Set) {
          for (const v0 of Array.from(val)) {
            const v1 = applyReviver(reviver, val, v0, v0);
            if (v1 === void 0)
              val.delete(v0);
            else if (v1 !== v0) {
              val.delete(v0);
              val.add(v1);
            }
          }
        } else {
          for (const [k, v0] of Object.entries(val)) {
            const v1 = applyReviver(reviver, val, k, v0);
            if (v1 === void 0)
              delete val[k];
            else if (v1 !== v0)
              val[k] = v1;
          }
        }
      }
      return reviver.call(obj, key, val);
    }
    exports2.applyReviver = applyReviver;
  }
});

// ../../node_modules/yaml/dist/nodes/toJS.js
var require_toJS = __commonJS({
  "../../node_modules/yaml/dist/nodes/toJS.js"(exports2) {
    "use strict";
    var identity = require_identity();
    function toJS(value, arg, ctx) {
      if (Array.isArray(value))
        return value.map((v, i) => toJS(v, String(i), ctx));
      if (value && typeof value.toJSON === "function") {
        if (!ctx || !identity.hasAnchor(value))
          return value.toJSON(arg, ctx);
        const data = { aliasCount: 0, count: 1, res: void 0 };
        ctx.anchors.set(value, data);
        ctx.onCreate = (res2) => {
          data.res = res2;
          delete ctx.onCreate;
        };
        const res = value.toJSON(arg, ctx);
        if (ctx.onCreate)
          ctx.onCreate(res);
        return res;
      }
      if (typeof value === "bigint" && !ctx?.keep)
        return Number(value);
      return value;
    }
    exports2.toJS = toJS;
  }
});

// ../../node_modules/yaml/dist/nodes/Node.js
var require_Node = __commonJS({
  "../../node_modules/yaml/dist/nodes/Node.js"(exports2) {
    "use strict";
    var applyReviver = require_applyReviver();
    var identity = require_identity();
    var toJS = require_toJS();
    var NodeBase = class {
      constructor(type) {
        Object.defineProperty(this, identity.NODE_TYPE, { value: type });
      }
      /** Create a copy of this node.  */
      clone() {
        const copy = Object.create(Object.getPrototypeOf(this), Object.getOwnPropertyDescriptors(this));
        if (this.range)
          copy.range = this.range.slice();
        return copy;
      }
      /** A plain JavaScript representation of this node. */
      toJS(doc, { mapAsMap, maxAliasCount, onAnchor, reviver } = {}) {
        if (!identity.isDocument(doc))
          throw new TypeError("A document argument is required");
        const ctx = {
          anchors: /* @__PURE__ */ new Map(),
          doc,
          keep: true,
          mapAsMap: mapAsMap === true,
          mapKeyWarned: false,
          maxAliasCount: typeof maxAliasCount === "number" ? maxAliasCount : 100
        };
        const res = toJS.toJS(this, "", ctx);
        if (typeof onAnchor === "function")
          for (const { count, res: res2 } of ctx.anchors.values())
            onAnchor(res2, count);
        return typeof reviver === "function" ? applyReviver.applyReviver(reviver, { "": res }, "", res) : res;
      }
    };
    exports2.NodeBase = NodeBase;
  }
});

// ../../node_modules/yaml/dist/nodes/Alias.js
var require_Alias = __commonJS({
  "../../node_modules/yaml/dist/nodes/Alias.js"(exports2) {
    "use strict";
    var anchors = require_anchors();
    var visit = require_visit();
    var identity = require_identity();
    var Node = require_Node();
    var toJS = require_toJS();
    var Alias = class extends Node.NodeBase {
      constructor(source) {
        super(identity.ALIAS);
        this.source = source;
        Object.defineProperty(this, "tag", {
          set() {
            throw new Error("Alias nodes cannot have tags");
          }
        });
      }
      /**
       * Resolve the value of this alias within `doc`, finding the last
       * instance of the `source` anchor before this node.
       */
      resolve(doc, ctx) {
        if (ctx?.maxAliasCount === 0)
          throw new ReferenceError("Alias resolution is disabled");
        let nodes;
        if (ctx?.aliasResolveCache) {
          nodes = ctx.aliasResolveCache;
        } else {
          nodes = [];
          visit.visit(doc, {
            Node: (_key, node) => {
              if (identity.isAlias(node) || identity.hasAnchor(node))
                nodes.push(node);
            }
          });
          if (ctx)
            ctx.aliasResolveCache = nodes;
        }
        let found = void 0;
        for (const node of nodes) {
          if (node === this)
            break;
          if (node.anchor === this.source)
            found = node;
        }
        if (found && ctx) {
          const { anchors: anchors2, doc: doc2, maxAliasCount } = ctx;
          let data = anchors2.get(found);
          if (!data) {
            toJS.toJS(found, null, ctx);
            data = anchors2.get(found);
          }
          if (data?.res === void 0) {
            const msg = "This should not happen: Alias anchor was not resolved?";
            throw new ReferenceError(msg);
          }
          if (maxAliasCount >= 0) {
            data.count += 1;
            if (data.aliasCount === 0)
              data.aliasCount = getAliasCount(doc2, found, anchors2);
            if (data.count * data.aliasCount > maxAliasCount) {
              const msg = "Excessive alias count indicates a resource exhaustion attack";
              throw new ReferenceError(msg);
            }
          }
        }
        return found;
      }
      toJSON(_arg, ctx) {
        if (!ctx)
          return { source: this.source };
        const source = this.resolve(ctx.doc, ctx);
        if (!source) {
          const msg = `Unresolved alias (the anchor must be set before the alias): ${this.source}`;
          throw new ReferenceError(msg);
        }
        return ctx.anchors.get(source).res;
      }
      toString(ctx, _onComment, _onChompKeep) {
        const src = `*${this.source}`;
        if (ctx) {
          anchors.anchorIsValid(this.source);
          if (ctx.options.verifyAliasOrder && !ctx.anchors.has(this.source)) {
            const msg = `Unresolved alias (the anchor must be set before the alias): ${this.source}`;
            throw new Error(msg);
          }
          if (ctx.implicitKey)
            return `${src} `;
        }
        return src;
      }
    };
    function getAliasCount(doc, node, anchors2) {
      if (identity.isAlias(node)) {
        const source = node.resolve(doc);
        const anchor = anchors2 && source && anchors2.get(source);
        return anchor ? anchor.count * anchor.aliasCount : 0;
      } else if (identity.isCollection(node)) {
        let count = 0;
        for (const item of node.items) {
          const c = getAliasCount(doc, item, anchors2);
          if (c > count)
            count = c;
        }
        return count;
      } else if (identity.isPair(node)) {
        const kc = getAliasCount(doc, node.key, anchors2);
        const vc = getAliasCount(doc, node.value, anchors2);
        return Math.max(kc, vc);
      }
      return 1;
    }
    exports2.Alias = Alias;
  }
});

// ../../node_modules/yaml/dist/nodes/Scalar.js
var require_Scalar = __commonJS({
  "../../node_modules/yaml/dist/nodes/Scalar.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var Node = require_Node();
    var toJS = require_toJS();
    var isScalarValue = (value) => !value || typeof value !== "function" && typeof value !== "object";
    var Scalar2 = class extends Node.NodeBase {
      constructor(value) {
        super(identity.SCALAR);
        this.value = value;
      }
      toJSON(arg, ctx) {
        return ctx?.keep ? this.value : toJS.toJS(this.value, arg, ctx);
      }
      toString() {
        return String(this.value);
      }
    };
    Scalar2.BLOCK_FOLDED = "BLOCK_FOLDED";
    Scalar2.BLOCK_LITERAL = "BLOCK_LITERAL";
    Scalar2.PLAIN = "PLAIN";
    Scalar2.QUOTE_DOUBLE = "QUOTE_DOUBLE";
    Scalar2.QUOTE_SINGLE = "QUOTE_SINGLE";
    exports2.Scalar = Scalar2;
    exports2.isScalarValue = isScalarValue;
  }
});

// ../../node_modules/yaml/dist/doc/createNode.js
var require_createNode = __commonJS({
  "../../node_modules/yaml/dist/doc/createNode.js"(exports2) {
    "use strict";
    var Alias = require_Alias();
    var identity = require_identity();
    var Scalar2 = require_Scalar();
    var defaultTagPrefix = "tag:yaml.org,2002:";
    function findTagObject(value, tagName, tags) {
      if (tagName) {
        const match = tags.filter((t) => t.tag === tagName);
        const tagObj = match.find((t) => !t.format) ?? match[0];
        if (!tagObj)
          throw new Error(`Tag ${tagName} not found`);
        return tagObj;
      }
      return tags.find((t) => t.identify?.(value) && !t.format);
    }
    function createNode(value, tagName, ctx) {
      if (identity.isDocument(value))
        value = value.contents;
      if (identity.isNode(value))
        return value;
      if (identity.isPair(value)) {
        const map = ctx.schema[identity.MAP].createNode?.(ctx.schema, null, ctx);
        map.items.push(value);
        return map;
      }
      if (value instanceof String || value instanceof Number || value instanceof Boolean || typeof BigInt !== "undefined" && value instanceof BigInt) {
        value = value.valueOf();
      }
      const { aliasDuplicateObjects, onAnchor, onTagObj, schema, sourceObjects } = ctx;
      let ref2 = void 0;
      if (aliasDuplicateObjects && value && typeof value === "object") {
        ref2 = sourceObjects.get(value);
        if (ref2) {
          ref2.anchor ?? (ref2.anchor = onAnchor(value));
          return new Alias.Alias(ref2.anchor);
        } else {
          ref2 = { anchor: null, node: null };
          sourceObjects.set(value, ref2);
        }
      }
      if (tagName?.startsWith("!!"))
        tagName = defaultTagPrefix + tagName.slice(2);
      let tagObj = findTagObject(value, tagName, schema.tags);
      if (!tagObj) {
        if (value && typeof value.toJSON === "function") {
          value = value.toJSON();
        }
        if (!value || typeof value !== "object") {
          const node2 = new Scalar2.Scalar(value);
          if (ref2)
            ref2.node = node2;
          return node2;
        }
        tagObj = value instanceof Map ? schema[identity.MAP] : Symbol.iterator in Object(value) ? schema[identity.SEQ] : schema[identity.MAP];
      }
      if (onTagObj) {
        onTagObj(tagObj);
        delete ctx.onTagObj;
      }
      const node = tagObj?.createNode ? tagObj.createNode(ctx.schema, value, ctx) : typeof tagObj?.nodeClass?.from === "function" ? tagObj.nodeClass.from(ctx.schema, value, ctx) : new Scalar2.Scalar(value);
      if (tagName)
        node.tag = tagName;
      else if (!tagObj.default)
        node.tag = tagObj.tag;
      if (ref2)
        ref2.node = node;
      return node;
    }
    exports2.createNode = createNode;
  }
});

// ../../node_modules/yaml/dist/nodes/Collection.js
var require_Collection = __commonJS({
  "../../node_modules/yaml/dist/nodes/Collection.js"(exports2) {
    "use strict";
    var createNode = require_createNode();
    var identity = require_identity();
    var Node = require_Node();
    function collectionFromPath(schema, path27, value) {
      let v = value;
      for (let i = path27.length - 1; i >= 0; --i) {
        const k = path27[i];
        if (typeof k === "number" && Number.isInteger(k) && k >= 0) {
          const a = [];
          a[k] = v;
          v = a;
        } else {
          v = /* @__PURE__ */ new Map([[k, v]]);
        }
      }
      return createNode.createNode(v, void 0, {
        aliasDuplicateObjects: false,
        keepUndefined: false,
        onAnchor: () => {
          throw new Error("This should not happen, please report a bug.");
        },
        schema,
        sourceObjects: /* @__PURE__ */ new Map()
      });
    }
    var isEmptyPath = (path27) => path27 == null || typeof path27 === "object" && !!path27[Symbol.iterator]().next().done;
    var Collection = class extends Node.NodeBase {
      constructor(type, schema) {
        super(type);
        Object.defineProperty(this, "schema", {
          value: schema,
          configurable: true,
          enumerable: false,
          writable: true
        });
      }
      /**
       * Create a copy of this collection.
       *
       * @param schema - If defined, overwrites the original's schema
       */
      clone(schema) {
        const copy = Object.create(Object.getPrototypeOf(this), Object.getOwnPropertyDescriptors(this));
        if (schema)
          copy.schema = schema;
        copy.items = copy.items.map((it) => identity.isNode(it) || identity.isPair(it) ? it.clone(schema) : it);
        if (this.range)
          copy.range = this.range.slice();
        return copy;
      }
      /**
       * Adds a value to the collection. For `!!map` and `!!omap` the value must
       * be a Pair instance or a `{ key, value }` object, which may not have a key
       * that already exists in the map.
       */
      addIn(path27, value) {
        if (isEmptyPath(path27))
          this.add(value);
        else {
          const [key, ...rest] = path27;
          const node = this.get(key, true);
          if (identity.isCollection(node))
            node.addIn(rest, value);
          else if (node === void 0 && this.schema)
            this.set(key, collectionFromPath(this.schema, rest, value));
          else
            throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
        }
      }
      /**
       * Removes a value from the collection.
       * @returns `true` if the item was found and removed.
       */
      deleteIn(path27) {
        const [key, ...rest] = path27;
        if (rest.length === 0)
          return this.delete(key);
        const node = this.get(key, true);
        if (identity.isCollection(node))
          return node.deleteIn(rest);
        else
          throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
      }
      /**
       * Returns item at `key`, or `undefined` if not found. By default unwraps
       * scalar values from their surrounding node; to disable set `keepScalar` to
       * `true` (collections are always returned intact).
       */
      getIn(path27, keepScalar) {
        const [key, ...rest] = path27;
        const node = this.get(key, true);
        if (rest.length === 0)
          return !keepScalar && identity.isScalar(node) ? node.value : node;
        else
          return identity.isCollection(node) ? node.getIn(rest, keepScalar) : void 0;
      }
      hasAllNullValues(allowScalar) {
        return this.items.every((node) => {
          if (!identity.isPair(node))
            return false;
          const n = node.value;
          return n == null || allowScalar && identity.isScalar(n) && n.value == null && !n.commentBefore && !n.comment && !n.tag;
        });
      }
      /**
       * Checks if the collection includes a value with the key `key`.
       */
      hasIn(path27) {
        const [key, ...rest] = path27;
        if (rest.length === 0)
          return this.has(key);
        const node = this.get(key, true);
        return identity.isCollection(node) ? node.hasIn(rest) : false;
      }
      /**
       * Sets a value in this collection. For `!!set`, `value` needs to be a
       * boolean to add/remove the item from the set.
       */
      setIn(path27, value) {
        const [key, ...rest] = path27;
        if (rest.length === 0) {
          this.set(key, value);
        } else {
          const node = this.get(key, true);
          if (identity.isCollection(node))
            node.setIn(rest, value);
          else if (node === void 0 && this.schema)
            this.set(key, collectionFromPath(this.schema, rest, value));
          else
            throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
        }
      }
    };
    exports2.Collection = Collection;
    exports2.collectionFromPath = collectionFromPath;
    exports2.isEmptyPath = isEmptyPath;
  }
});

// ../../node_modules/yaml/dist/stringify/stringifyComment.js
var require_stringifyComment = __commonJS({
  "../../node_modules/yaml/dist/stringify/stringifyComment.js"(exports2) {
    "use strict";
    var stringifyComment = (str3) => str3.replace(/^(?!$)(?: $)?/gm, "#");
    function indentComment(comment, indent) {
      if (/^\n+$/.test(comment))
        return comment.substring(1);
      return indent ? comment.replace(/^(?! *$)/gm, indent) : comment;
    }
    var lineComment = (str3, indent, comment) => str3.endsWith("\n") ? indentComment(comment, indent) : comment.includes("\n") ? "\n" + indentComment(comment, indent) : (str3.endsWith(" ") ? "" : " ") + comment;
    exports2.indentComment = indentComment;
    exports2.lineComment = lineComment;
    exports2.stringifyComment = stringifyComment;
  }
});

// ../../node_modules/yaml/dist/stringify/foldFlowLines.js
var require_foldFlowLines = __commonJS({
  "../../node_modules/yaml/dist/stringify/foldFlowLines.js"(exports2) {
    "use strict";
    var FOLD_FLOW = "flow";
    var FOLD_BLOCK = "block";
    var FOLD_QUOTED = "quoted";
    function foldFlowLines(text, indent, mode = "flow", { indentAtStart, lineWidth = 80, minContentWidth = 20, onFold, onOverflow } = {}) {
      if (!lineWidth || lineWidth < 0)
        return text;
      if (lineWidth < minContentWidth)
        minContentWidth = 0;
      const endStep = Math.max(1 + minContentWidth, 1 + lineWidth - indent.length);
      if (text.length <= endStep)
        return text;
      const folds = [];
      const escapedFolds = {};
      let end = lineWidth - indent.length;
      if (typeof indentAtStart === "number") {
        if (indentAtStart > lineWidth - Math.max(2, minContentWidth))
          folds.push(0);
        else
          end = lineWidth - indentAtStart;
      }
      let split = void 0;
      let prev = void 0;
      let overflow = false;
      let i = -1;
      let escStart = -1;
      let escEnd = -1;
      if (mode === FOLD_BLOCK) {
        i = consumeMoreIndentedLines(text, i, indent.length);
        if (i !== -1)
          end = i + endStep;
      }
      for (let ch; ch = text[i += 1]; ) {
        if (mode === FOLD_QUOTED && ch === "\\") {
          escStart = i;
          switch (text[i + 1]) {
            case "x":
              i += 3;
              break;
            case "u":
              i += 5;
              break;
            case "U":
              i += 9;
              break;
            default:
              i += 1;
          }
          escEnd = i;
        }
        if (ch === "\n") {
          if (mode === FOLD_BLOCK)
            i = consumeMoreIndentedLines(text, i, indent.length);
          end = i + indent.length + endStep;
          split = void 0;
        } else {
          if (ch === " " && prev && prev !== " " && prev !== "\n" && prev !== "	") {
            const next = text[i + 1];
            if (next && next !== " " && next !== "\n" && next !== "	")
              split = i;
          }
          if (i >= end) {
            if (split) {
              folds.push(split);
              end = split + endStep;
              split = void 0;
            } else if (mode === FOLD_QUOTED) {
              while (prev === " " || prev === "	") {
                prev = ch;
                ch = text[i += 1];
                overflow = true;
              }
              const j = i > escEnd + 1 ? i - 2 : escStart - 1;
              if (escapedFolds[j])
                return text;
              folds.push(j);
              escapedFolds[j] = true;
              end = j + endStep;
              split = void 0;
            } else {
              overflow = true;
            }
          }
        }
        prev = ch;
      }
      if (overflow && onOverflow)
        onOverflow();
      if (folds.length === 0)
        return text;
      if (onFold)
        onFold();
      let res = text.slice(0, folds[0]);
      for (let i2 = 0; i2 < folds.length; ++i2) {
        const fold = folds[i2];
        const end2 = folds[i2 + 1] || text.length;
        if (fold === 0)
          res = `
${indent}${text.slice(0, end2)}`;
        else {
          if (mode === FOLD_QUOTED && escapedFolds[fold])
            res += `${text[fold]}\\`;
          res += `
${indent}${text.slice(fold + 1, end2)}`;
        }
      }
      return res;
    }
    function consumeMoreIndentedLines(text, i, indent) {
      let end = i;
      let start = i + 1;
      let ch = text[start];
      while (ch === " " || ch === "	") {
        if (i < start + indent) {
          ch = text[++i];
        } else {
          do {
            ch = text[++i];
          } while (ch && ch !== "\n");
          end = i;
          start = i + 1;
          ch = text[start];
        }
      }
      return end;
    }
    exports2.FOLD_BLOCK = FOLD_BLOCK;
    exports2.FOLD_FLOW = FOLD_FLOW;
    exports2.FOLD_QUOTED = FOLD_QUOTED;
    exports2.foldFlowLines = foldFlowLines;
  }
});

// ../../node_modules/yaml/dist/stringify/stringifyString.js
var require_stringifyString = __commonJS({
  "../../node_modules/yaml/dist/stringify/stringifyString.js"(exports2) {
    "use strict";
    var Scalar2 = require_Scalar();
    var foldFlowLines = require_foldFlowLines();
    var getFoldOptions = (ctx, isBlock) => ({
      indentAtStart: isBlock ? ctx.indent.length : ctx.indentAtStart,
      lineWidth: ctx.options.lineWidth,
      minContentWidth: ctx.options.minContentWidth
    });
    var containsDocumentMarker = (str3) => /^(%|---|\.\.\.)/m.test(str3);
    function lineLengthOverLimit(str3, lineWidth, indentLength) {
      if (!lineWidth || lineWidth < 0)
        return false;
      const limit = lineWidth - indentLength;
      const strLen = str3.length;
      if (strLen <= limit)
        return false;
      for (let i = 0, start = 0; i < strLen; ++i) {
        if (str3[i] === "\n") {
          if (i - start > limit)
            return true;
          start = i + 1;
          if (strLen - start <= limit)
            return false;
        }
      }
      return true;
    }
    function doubleQuotedString(value, ctx) {
      const json = JSON.stringify(value);
      if (ctx.options.doubleQuotedAsJSON)
        return json;
      const { implicitKey } = ctx;
      const minMultiLineLength = ctx.options.doubleQuotedMinMultiLineLength;
      const indent = ctx.indent || (containsDocumentMarker(value) ? "  " : "");
      let str3 = "";
      let start = 0;
      for (let i = 0, ch = json[i]; ch; ch = json[++i]) {
        if (ch === " " && json[i + 1] === "\\" && json[i + 2] === "n") {
          str3 += json.slice(start, i) + "\\ ";
          i += 1;
          start = i;
          ch = "\\";
        }
        if (ch === "\\")
          switch (json[i + 1]) {
            case "u":
              {
                str3 += json.slice(start, i);
                const code = json.substr(i + 2, 4);
                switch (code) {
                  case "0000":
                    str3 += "\\0";
                    break;
                  case "0007":
                    str3 += "\\a";
                    break;
                  case "000b":
                    str3 += "\\v";
                    break;
                  case "001b":
                    str3 += "\\e";
                    break;
                  case "0085":
                    str3 += "\\N";
                    break;
                  case "00a0":
                    str3 += "\\_";
                    break;
                  case "2028":
                    str3 += "\\L";
                    break;
                  case "2029":
                    str3 += "\\P";
                    break;
                  default:
                    if (code.substr(0, 2) === "00")
                      str3 += "\\x" + code.substr(2);
                    else
                      str3 += json.substr(i, 6);
                }
                i += 5;
                start = i + 1;
              }
              break;
            case "n":
              if (implicitKey || json[i + 2] === '"' || json.length < minMultiLineLength) {
                i += 1;
              } else {
                str3 += json.slice(start, i) + "\n\n";
                while (json[i + 2] === "\\" && json[i + 3] === "n" && json[i + 4] !== '"') {
                  str3 += "\n";
                  i += 2;
                }
                str3 += indent;
                if (json[i + 2] === " ")
                  str3 += "\\";
                i += 1;
                start = i + 1;
              }
              break;
            default:
              i += 1;
          }
      }
      str3 = start ? str3 + json.slice(start) : json;
      return implicitKey ? str3 : foldFlowLines.foldFlowLines(str3, indent, foldFlowLines.FOLD_QUOTED, getFoldOptions(ctx, false));
    }
    function singleQuotedString(value, ctx) {
      if (ctx.options.singleQuote === false || ctx.implicitKey && value.includes("\n") || /[ \t]\n|\n[ \t]/.test(value))
        return doubleQuotedString(value, ctx);
      const indent = ctx.indent || (containsDocumentMarker(value) ? "  " : "");
      const res = "'" + value.replace(/'/g, "''").replace(/\n+/g, `$&
${indent}`) + "'";
      return ctx.implicitKey ? res : foldFlowLines.foldFlowLines(res, indent, foldFlowLines.FOLD_FLOW, getFoldOptions(ctx, false));
    }
    function quotedString(value, ctx) {
      const { singleQuote } = ctx.options;
      let qs;
      if (singleQuote === false)
        qs = doubleQuotedString;
      else {
        const hasDouble = value.includes('"');
        const hasSingle = value.includes("'");
        if (hasDouble && !hasSingle)
          qs = singleQuotedString;
        else if (hasSingle && !hasDouble)
          qs = doubleQuotedString;
        else
          qs = singleQuote ? singleQuotedString : doubleQuotedString;
      }
      return qs(value, ctx);
    }
    var blockEndNewlines;
    try {
      blockEndNewlines = new RegExp("(^|(?<!\n))\n+(?!\n|$)", "g");
    } catch {
      blockEndNewlines = /\n+(?!\n|$)/g;
    }
    function blockString({ comment, type, value }, ctx, onComment, onChompKeep) {
      const { blockQuote, commentString, lineWidth } = ctx.options;
      if (!blockQuote || /\n[\t ]+$/.test(value)) {
        return quotedString(value, ctx);
      }
      const indent = ctx.indent || (ctx.forceBlockIndent || containsDocumentMarker(value) ? "  " : "");
      const literal = blockQuote === "literal" ? true : blockQuote === "folded" || type === Scalar2.Scalar.BLOCK_FOLDED ? false : type === Scalar2.Scalar.BLOCK_LITERAL ? true : !lineLengthOverLimit(value, lineWidth, indent.length);
      if (!value)
        return literal ? "|\n" : ">\n";
      let chomp;
      let endStart;
      for (endStart = value.length; endStart > 0; --endStart) {
        const ch = value[endStart - 1];
        if (ch !== "\n" && ch !== "	" && ch !== " ")
          break;
      }
      let end = value.substring(endStart);
      const endNlPos = end.indexOf("\n");
      if (endNlPos === -1) {
        chomp = "-";
      } else if (value === end || endNlPos !== end.length - 1) {
        chomp = "+";
        if (onChompKeep)
          onChompKeep();
      } else {
        chomp = "";
      }
      if (end) {
        value = value.slice(0, -end.length);
        if (end[end.length - 1] === "\n")
          end = end.slice(0, -1);
        end = end.replace(blockEndNewlines, `$&${indent}`);
      }
      let startWithSpace = false;
      let startEnd;
      let startNlPos = -1;
      for (startEnd = 0; startEnd < value.length; ++startEnd) {
        const ch = value[startEnd];
        if (ch === " ")
          startWithSpace = true;
        else if (ch === "\n")
          startNlPos = startEnd;
        else
          break;
      }
      let start = value.substring(0, startNlPos < startEnd ? startNlPos + 1 : startEnd);
      if (start) {
        value = value.substring(start.length);
        start = start.replace(/\n+/g, `$&${indent}`);
      }
      const indentSize = indent ? "2" : "1";
      let header = (startWithSpace ? indentSize : "") + chomp;
      if (comment) {
        header += " " + commentString(comment.replace(/ ?[\r\n]+/g, " "));
        if (onComment)
          onComment();
      }
      if (!literal) {
        const foldedValue = value.replace(/\n+/g, "\n$&").replace(/(?:^|\n)([\t ].*)(?:([\n\t ]*)\n(?![\n\t ]))?/g, "$1$2").replace(/\n+/g, `$&${indent}`);
        let literalFallback = false;
        const foldOptions = getFoldOptions(ctx, true);
        if (blockQuote !== "folded" && type !== Scalar2.Scalar.BLOCK_FOLDED) {
          foldOptions.onOverflow = () => {
            literalFallback = true;
          };
        }
        const body = foldFlowLines.foldFlowLines(`${start}${foldedValue}${end}`, indent, foldFlowLines.FOLD_BLOCK, foldOptions);
        if (!literalFallback)
          return `>${header}
${indent}${body}`;
      }
      value = value.replace(/\n+/g, `$&${indent}`);
      return `|${header}
${indent}${start}${value}${end}`;
    }
    function plainString(item, ctx, onComment, onChompKeep) {
      const { type, value } = item;
      const { actualString, implicitKey, indent, indentStep, inFlow } = ctx;
      if (implicitKey && value.includes("\n") || inFlow && /[[\]{},]/.test(value)) {
        return quotedString(value, ctx);
      }
      if (/^[\n\t ,[\]{}#&*!|>'"%@`]|^[?-]$|^[?-][ \t]|[\n:][ \t]|[ \t]\n|[\n\t ]#|[\n\t :]$/.test(value)) {
        return implicitKey || inFlow || !value.includes("\n") ? quotedString(value, ctx) : blockString(item, ctx, onComment, onChompKeep);
      }
      if (!implicitKey && !inFlow && type !== Scalar2.Scalar.PLAIN && value.includes("\n")) {
        return blockString(item, ctx, onComment, onChompKeep);
      }
      if (containsDocumentMarker(value)) {
        if (indent === "") {
          ctx.forceBlockIndent = true;
          return blockString(item, ctx, onComment, onChompKeep);
        } else if (implicitKey && indent === indentStep) {
          return quotedString(value, ctx);
        }
      }
      const str3 = value.replace(/\n+/g, `$&
${indent}`);
      if (actualString) {
        const test = (tag) => tag.default && tag.tag !== "tag:yaml.org,2002:str" && tag.test?.test(str3);
        const { compat, tags } = ctx.doc.schema;
        if (tags.some(test) || compat?.some(test))
          return quotedString(value, ctx);
      }
      return implicitKey ? str3 : foldFlowLines.foldFlowLines(str3, indent, foldFlowLines.FOLD_FLOW, getFoldOptions(ctx, false));
    }
    function stringifyString(item, ctx, onComment, onChompKeep) {
      const { implicitKey, inFlow } = ctx;
      const ss = typeof item.value === "string" ? item : Object.assign({}, item, { value: String(item.value) });
      let { type } = item;
      if (type !== Scalar2.Scalar.QUOTE_DOUBLE) {
        if (/[\x00-\x08\x0b-\x1f\x7f-\x9f\u{D800}-\u{DFFF}]/u.test(ss.value))
          type = Scalar2.Scalar.QUOTE_DOUBLE;
      }
      const _stringify = (_type) => {
        switch (_type) {
          case Scalar2.Scalar.BLOCK_FOLDED:
          case Scalar2.Scalar.BLOCK_LITERAL:
            return implicitKey || inFlow ? quotedString(ss.value, ctx) : blockString(ss, ctx, onComment, onChompKeep);
          case Scalar2.Scalar.QUOTE_DOUBLE:
            return doubleQuotedString(ss.value, ctx);
          case Scalar2.Scalar.QUOTE_SINGLE:
            return singleQuotedString(ss.value, ctx);
          case Scalar2.Scalar.PLAIN:
            return plainString(ss, ctx, onComment, onChompKeep);
          default:
            return null;
        }
      };
      let res = _stringify(type);
      if (res === null) {
        const { defaultKeyType, defaultStringType } = ctx.options;
        const t = implicitKey && defaultKeyType || defaultStringType;
        res = _stringify(t);
        if (res === null)
          throw new Error(`Unsupported default string type ${t}`);
      }
      return res;
    }
    exports2.stringifyString = stringifyString;
  }
});

// ../../node_modules/yaml/dist/stringify/stringify.js
var require_stringify = __commonJS({
  "../../node_modules/yaml/dist/stringify/stringify.js"(exports2) {
    "use strict";
    var anchors = require_anchors();
    var identity = require_identity();
    var stringifyComment = require_stringifyComment();
    var stringifyString = require_stringifyString();
    function createStringifyContext(doc, options) {
      const opt = Object.assign({
        blockQuote: true,
        commentString: stringifyComment.stringifyComment,
        defaultKeyType: null,
        defaultStringType: "PLAIN",
        directives: null,
        doubleQuotedAsJSON: false,
        doubleQuotedMinMultiLineLength: 40,
        falseStr: "false",
        flowCollectionPadding: true,
        indentSeq: true,
        lineWidth: 80,
        minContentWidth: 20,
        nullStr: "null",
        simpleKeys: false,
        singleQuote: null,
        trailingComma: false,
        trueStr: "true",
        verifyAliasOrder: true
      }, doc.schema.toStringOptions, options);
      let inFlow;
      switch (opt.collectionStyle) {
        case "block":
          inFlow = false;
          break;
        case "flow":
          inFlow = true;
          break;
        default:
          inFlow = null;
      }
      return {
        anchors: /* @__PURE__ */ new Set(),
        doc,
        flowCollectionPadding: opt.flowCollectionPadding ? " " : "",
        indent: "",
        indentStep: typeof opt.indent === "number" ? " ".repeat(opt.indent) : "  ",
        inFlow,
        options: opt
      };
    }
    function getTagObject(tags, item) {
      if (item.tag) {
        const match = tags.filter((t) => t.tag === item.tag);
        if (match.length > 0)
          return match.find((t) => t.format === item.format) ?? match[0];
      }
      let tagObj = void 0;
      let obj;
      if (identity.isScalar(item)) {
        obj = item.value;
        let match = tags.filter((t) => t.identify?.(obj));
        if (match.length > 1) {
          const testMatch = match.filter((t) => t.test);
          if (testMatch.length > 0)
            match = testMatch;
        }
        tagObj = match.find((t) => t.format === item.format) ?? match.find((t) => !t.format);
      } else {
        obj = item;
        tagObj = tags.find((t) => t.nodeClass && obj instanceof t.nodeClass);
      }
      if (!tagObj) {
        const name = obj?.constructor?.name ?? (obj === null ? "null" : typeof obj);
        throw new Error(`Tag not resolved for ${name} value`);
      }
      return tagObj;
    }
    function stringifyProps(node, tagObj, { anchors: anchors$1, doc }) {
      if (!doc.directives)
        return "";
      const props = [];
      const anchor = (identity.isScalar(node) || identity.isCollection(node)) && node.anchor;
      if (anchor && anchors.anchorIsValid(anchor)) {
        anchors$1.add(anchor);
        props.push(`&${anchor}`);
      }
      const tag = node.tag ?? (tagObj.default ? null : tagObj.tag);
      if (tag)
        props.push(doc.directives.tagString(tag));
      return props.join(" ");
    }
    function stringify(item, ctx, onComment, onChompKeep) {
      if (identity.isPair(item))
        return item.toString(ctx, onComment, onChompKeep);
      if (identity.isAlias(item)) {
        if (ctx.doc.directives)
          return item.toString(ctx);
        if (ctx.resolvedAliases?.has(item)) {
          throw new TypeError(`Cannot stringify circular structure without alias nodes`);
        } else {
          if (ctx.resolvedAliases)
            ctx.resolvedAliases.add(item);
          else
            ctx.resolvedAliases = /* @__PURE__ */ new Set([item]);
          item = item.resolve(ctx.doc);
        }
      }
      let tagObj = void 0;
      const node = identity.isNode(item) ? item : ctx.doc.createNode(item, { onTagObj: (o) => tagObj = o });
      tagObj ?? (tagObj = getTagObject(ctx.doc.schema.tags, node));
      const props = stringifyProps(node, tagObj, ctx);
      if (props.length > 0)
        ctx.indentAtStart = (ctx.indentAtStart ?? 0) + props.length + 1;
      const str3 = typeof tagObj.stringify === "function" ? tagObj.stringify(node, ctx, onComment, onChompKeep) : identity.isScalar(node) ? stringifyString.stringifyString(node, ctx, onComment, onChompKeep) : node.toString(ctx, onComment, onChompKeep);
      if (!props)
        return str3;
      return identity.isScalar(node) || str3[0] === "{" || str3[0] === "[" ? `${props} ${str3}` : `${props}
${ctx.indent}${str3}`;
    }
    exports2.createStringifyContext = createStringifyContext;
    exports2.stringify = stringify;
  }
});

// ../../node_modules/yaml/dist/stringify/stringifyPair.js
var require_stringifyPair = __commonJS({
  "../../node_modules/yaml/dist/stringify/stringifyPair.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var Scalar2 = require_Scalar();
    var stringify = require_stringify();
    var stringifyComment = require_stringifyComment();
    function stringifyPair({ key, value }, ctx, onComment, onChompKeep) {
      const { allNullValues, doc, indent, indentStep, options: { commentString, indentSeq, simpleKeys } } = ctx;
      let keyComment = identity.isNode(key) && key.comment || null;
      if (simpleKeys) {
        if (keyComment) {
          throw new Error("With simple keys, key nodes cannot have comments");
        }
        if (identity.isCollection(key) || !identity.isNode(key) && typeof key === "object") {
          const msg = "With simple keys, collection cannot be used as a key value";
          throw new Error(msg);
        }
      }
      let explicitKey = !simpleKeys && (!key || keyComment && value == null && !ctx.inFlow || identity.isCollection(key) || (identity.isScalar(key) ? key.type === Scalar2.Scalar.BLOCK_FOLDED || key.type === Scalar2.Scalar.BLOCK_LITERAL : typeof key === "object"));
      ctx = Object.assign({}, ctx, {
        allNullValues: false,
        implicitKey: !explicitKey && (simpleKeys || !allNullValues),
        indent: indent + indentStep
      });
      let keyCommentDone = false;
      let chompKeep = false;
      let str3 = stringify.stringify(key, ctx, () => keyCommentDone = true, () => chompKeep = true);
      if (!explicitKey && !ctx.inFlow && str3.length > 1024) {
        if (simpleKeys)
          throw new Error("With simple keys, single line scalar must not span more than 1024 characters");
        explicitKey = true;
      }
      if (ctx.inFlow) {
        if (allNullValues || value == null) {
          if (keyCommentDone && onComment)
            onComment();
          return str3 === "" ? "?" : explicitKey ? `? ${str3}` : str3;
        }
      } else if (allNullValues && !simpleKeys || value == null && explicitKey) {
        str3 = `? ${str3}`;
        if (keyComment && !keyCommentDone) {
          str3 += stringifyComment.lineComment(str3, ctx.indent, commentString(keyComment));
        } else if (chompKeep && onChompKeep)
          onChompKeep();
        return str3;
      }
      if (keyCommentDone)
        keyComment = null;
      if (explicitKey) {
        if (keyComment)
          str3 += stringifyComment.lineComment(str3, ctx.indent, commentString(keyComment));
        str3 = `? ${str3}
${indent}:`;
      } else {
        str3 = `${str3}:`;
        if (keyComment)
          str3 += stringifyComment.lineComment(str3, ctx.indent, commentString(keyComment));
      }
      let vsb, vcb, valueComment;
      if (identity.isNode(value)) {
        vsb = !!value.spaceBefore;
        vcb = value.commentBefore;
        valueComment = value.comment;
      } else {
        vsb = false;
        vcb = null;
        valueComment = null;
        if (value && typeof value === "object")
          value = doc.createNode(value);
      }
      ctx.implicitKey = false;
      if (!explicitKey && !keyComment && identity.isScalar(value))
        ctx.indentAtStart = str3.length + 1;
      chompKeep = false;
      if (!indentSeq && indentStep.length >= 2 && !ctx.inFlow && !explicitKey && identity.isSeq(value) && !value.flow && !value.tag && !value.anchor) {
        ctx.indent = ctx.indent.substring(2);
      }
      let valueCommentDone = false;
      const valueStr = stringify.stringify(value, ctx, () => valueCommentDone = true, () => chompKeep = true);
      let ws = " ";
      if (keyComment || vsb || vcb) {
        ws = vsb ? "\n" : "";
        if (vcb) {
          const cs = commentString(vcb);
          ws += `
${stringifyComment.indentComment(cs, ctx.indent)}`;
        }
        if (valueStr === "" && !ctx.inFlow) {
          if (ws === "\n" && valueComment)
            ws = "\n\n";
        } else {
          ws += `
${ctx.indent}`;
        }
      } else if (!explicitKey && identity.isCollection(value)) {
        const vs0 = valueStr[0];
        const nl0 = valueStr.indexOf("\n");
        const hasNewline = nl0 !== -1;
        const flow = ctx.inFlow ?? value.flow ?? value.items.length === 0;
        if (hasNewline || !flow) {
          let hasPropsLine = false;
          if (hasNewline && (vs0 === "&" || vs0 === "!")) {
            let sp0 = valueStr.indexOf(" ");
            if (vs0 === "&" && sp0 !== -1 && sp0 < nl0 && valueStr[sp0 + 1] === "!") {
              sp0 = valueStr.indexOf(" ", sp0 + 1);
            }
            if (sp0 === -1 || nl0 < sp0)
              hasPropsLine = true;
          }
          if (!hasPropsLine)
            ws = `
${ctx.indent}`;
        }
      } else if (valueStr === "" || valueStr[0] === "\n") {
        ws = "";
      }
      str3 += ws + valueStr;
      if (ctx.inFlow) {
        if (valueCommentDone && onComment)
          onComment();
      } else if (valueComment && !valueCommentDone) {
        str3 += stringifyComment.lineComment(str3, ctx.indent, commentString(valueComment));
      } else if (chompKeep && onChompKeep) {
        onChompKeep();
      }
      return str3;
    }
    exports2.stringifyPair = stringifyPair;
  }
});

// ../../node_modules/yaml/dist/log.js
var require_log = __commonJS({
  "../../node_modules/yaml/dist/log.js"(exports2) {
    "use strict";
    var node_process = require("process");
    function debug(logLevel, ...messages) {
      if (logLevel === "debug")
        console.log(...messages);
    }
    function warn(logLevel, warning) {
      if (logLevel === "debug" || logLevel === "warn") {
        if (typeof node_process.emitWarning === "function")
          node_process.emitWarning(warning);
        else
          console.warn(warning);
      }
    }
    exports2.debug = debug;
    exports2.warn = warn;
  }
});

// ../../node_modules/yaml/dist/schema/yaml-1.1/merge.js
var require_merge = __commonJS({
  "../../node_modules/yaml/dist/schema/yaml-1.1/merge.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var Scalar2 = require_Scalar();
    var MERGE_KEY = "<<";
    var merge = {
      identify: (value) => value === MERGE_KEY || typeof value === "symbol" && value.description === MERGE_KEY,
      default: "key",
      tag: "tag:yaml.org,2002:merge",
      test: /^<<$/,
      resolve: () => Object.assign(new Scalar2.Scalar(Symbol(MERGE_KEY)), {
        addToJSMap: addMergeToJSMap
      }),
      stringify: () => MERGE_KEY
    };
    var isMergeKey = (ctx, key) => (merge.identify(key) || identity.isScalar(key) && (!key.type || key.type === Scalar2.Scalar.PLAIN) && merge.identify(key.value)) && ctx?.doc.schema.tags.some((tag) => tag.tag === merge.tag && tag.default);
    function addMergeToJSMap(ctx, map, value) {
      const source = resolveAliasValue(ctx, value);
      if (identity.isSeq(source))
        for (const it of source.items)
          mergeValue(ctx, map, it);
      else if (Array.isArray(source))
        for (const it of source)
          mergeValue(ctx, map, it);
      else
        mergeValue(ctx, map, source);
    }
    function mergeValue(ctx, map, value) {
      const source = resolveAliasValue(ctx, value);
      if (!identity.isMap(source))
        throw new Error("Merge sources must be maps or map aliases");
      const srcMap = source.toJSON(null, ctx, Map);
      for (const [key, value2] of srcMap) {
        if (map instanceof Map) {
          if (!map.has(key))
            map.set(key, value2);
        } else if (map instanceof Set) {
          map.add(key);
        } else if (!Object.prototype.hasOwnProperty.call(map, key)) {
          Object.defineProperty(map, key, {
            value: value2,
            writable: true,
            enumerable: true,
            configurable: true
          });
        }
      }
      return map;
    }
    function resolveAliasValue(ctx, value) {
      return ctx && identity.isAlias(value) ? value.resolve(ctx.doc, ctx) : value;
    }
    exports2.addMergeToJSMap = addMergeToJSMap;
    exports2.isMergeKey = isMergeKey;
    exports2.merge = merge;
  }
});

// ../../node_modules/yaml/dist/nodes/addPairToJSMap.js
var require_addPairToJSMap = __commonJS({
  "../../node_modules/yaml/dist/nodes/addPairToJSMap.js"(exports2) {
    "use strict";
    var log = require_log();
    var merge = require_merge();
    var stringify = require_stringify();
    var identity = require_identity();
    var toJS = require_toJS();
    function addPairToJSMap(ctx, map, { key, value }) {
      if (identity.isNode(key) && key.addToJSMap)
        key.addToJSMap(ctx, map, value);
      else if (merge.isMergeKey(ctx, key))
        merge.addMergeToJSMap(ctx, map, value);
      else {
        const jsKey = toJS.toJS(key, "", ctx);
        if (map instanceof Map) {
          map.set(jsKey, toJS.toJS(value, jsKey, ctx));
        } else if (map instanceof Set) {
          map.add(jsKey);
        } else {
          const stringKey = stringifyKey(key, jsKey, ctx);
          const jsValue = toJS.toJS(value, stringKey, ctx);
          if (stringKey in map)
            Object.defineProperty(map, stringKey, {
              value: jsValue,
              writable: true,
              enumerable: true,
              configurable: true
            });
          else
            map[stringKey] = jsValue;
        }
      }
      return map;
    }
    function stringifyKey(key, jsKey, ctx) {
      if (jsKey === null)
        return "";
      if (typeof jsKey !== "object")
        return String(jsKey);
      if (identity.isNode(key) && ctx?.doc) {
        const strCtx = stringify.createStringifyContext(ctx.doc, {});
        strCtx.anchors = /* @__PURE__ */ new Set();
        for (const node of ctx.anchors.keys())
          strCtx.anchors.add(node.anchor);
        strCtx.inFlow = true;
        strCtx.inStringifyKey = true;
        const strKey = key.toString(strCtx);
        if (!ctx.mapKeyWarned) {
          let jsonStr = JSON.stringify(strKey);
          if (jsonStr.length > 40)
            jsonStr = jsonStr.substring(0, 36) + '..."';
          log.warn(ctx.doc.options.logLevel, `Keys with collection values will be stringified due to JS Object restrictions: ${jsonStr}. Set mapAsMap: true to use object keys.`);
          ctx.mapKeyWarned = true;
        }
        return strKey;
      }
      return JSON.stringify(jsKey);
    }
    exports2.addPairToJSMap = addPairToJSMap;
  }
});

// ../../node_modules/yaml/dist/nodes/Pair.js
var require_Pair = __commonJS({
  "../../node_modules/yaml/dist/nodes/Pair.js"(exports2) {
    "use strict";
    var createNode = require_createNode();
    var stringifyPair = require_stringifyPair();
    var addPairToJSMap = require_addPairToJSMap();
    var identity = require_identity();
    function createPair(key, value, ctx) {
      const k = createNode.createNode(key, void 0, ctx);
      const v = createNode.createNode(value, void 0, ctx);
      return new Pair(k, v);
    }
    var Pair = class _Pair {
      constructor(key, value = null) {
        Object.defineProperty(this, identity.NODE_TYPE, { value: identity.PAIR });
        this.key = key;
        this.value = value;
      }
      clone(schema) {
        let { key, value } = this;
        if (identity.isNode(key))
          key = key.clone(schema);
        if (identity.isNode(value))
          value = value.clone(schema);
        return new _Pair(key, value);
      }
      toJSON(_, ctx) {
        const pair = ctx?.mapAsMap ? /* @__PURE__ */ new Map() : {};
        return addPairToJSMap.addPairToJSMap(ctx, pair, this);
      }
      toString(ctx, onComment, onChompKeep) {
        return ctx?.doc ? stringifyPair.stringifyPair(this, ctx, onComment, onChompKeep) : JSON.stringify(this);
      }
    };
    exports2.Pair = Pair;
    exports2.createPair = createPair;
  }
});

// ../../node_modules/yaml/dist/stringify/stringifyCollection.js
var require_stringifyCollection = __commonJS({
  "../../node_modules/yaml/dist/stringify/stringifyCollection.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var stringify = require_stringify();
    var stringifyComment = require_stringifyComment();
    function stringifyCollection(collection, ctx, options) {
      const flow = ctx.inFlow ?? collection.flow;
      const stringify2 = flow ? stringifyFlowCollection : stringifyBlockCollection;
      return stringify2(collection, ctx, options);
    }
    function stringifyBlockCollection({ comment, items: items2 }, ctx, { blockItemPrefix, flowChars, itemIndent, onChompKeep, onComment }) {
      const { indent, options: { commentString } } = ctx;
      const itemCtx = Object.assign({}, ctx, { indent: itemIndent, type: null });
      let chompKeep = false;
      const lines = [];
      for (let i = 0; i < items2.length; ++i) {
        const item = items2[i];
        let comment2 = null;
        if (identity.isNode(item)) {
          if (!chompKeep && item.spaceBefore)
            lines.push("");
          addCommentBefore(ctx, lines, item.commentBefore, chompKeep);
          if (item.comment)
            comment2 = item.comment;
        } else if (identity.isPair(item)) {
          const ik = identity.isNode(item.key) ? item.key : null;
          if (ik) {
            if (!chompKeep && ik.spaceBefore)
              lines.push("");
            addCommentBefore(ctx, lines, ik.commentBefore, chompKeep);
          }
        }
        chompKeep = false;
        let str4 = stringify.stringify(item, itemCtx, () => comment2 = null, () => chompKeep = true);
        if (comment2)
          str4 += stringifyComment.lineComment(str4, itemIndent, commentString(comment2));
        if (chompKeep && comment2)
          chompKeep = false;
        lines.push(blockItemPrefix + str4);
      }
      let str3;
      if (lines.length === 0) {
        str3 = flowChars.start + flowChars.end;
      } else {
        str3 = lines[0];
        for (let i = 1; i < lines.length; ++i) {
          const line2 = lines[i];
          str3 += line2 ? `
${indent}${line2}` : "\n";
        }
      }
      if (comment) {
        str3 += "\n" + stringifyComment.indentComment(commentString(comment), indent);
        if (onComment)
          onComment();
      } else if (chompKeep && onChompKeep)
        onChompKeep();
      return str3;
    }
    function stringifyFlowCollection({ items: items2 }, ctx, { flowChars, itemIndent }) {
      const { indent, indentStep, flowCollectionPadding: fcPadding, options: { commentString } } = ctx;
      itemIndent += indentStep;
      const itemCtx = Object.assign({}, ctx, {
        indent: itemIndent,
        inFlow: true,
        type: null
      });
      let reqNewline = false;
      let linesAtValue = 0;
      const lines = [];
      for (let i = 0; i < items2.length; ++i) {
        const item = items2[i];
        let comment = null;
        if (identity.isNode(item)) {
          if (item.spaceBefore)
            lines.push("");
          addCommentBefore(ctx, lines, item.commentBefore, false);
          if (item.comment)
            comment = item.comment;
        } else if (identity.isPair(item)) {
          const ik = identity.isNode(item.key) ? item.key : null;
          if (ik) {
            if (ik.spaceBefore)
              lines.push("");
            addCommentBefore(ctx, lines, ik.commentBefore, false);
            if (ik.comment)
              reqNewline = true;
          }
          const iv = identity.isNode(item.value) ? item.value : null;
          if (iv) {
            if (iv.comment)
              comment = iv.comment;
            if (iv.commentBefore)
              reqNewline = true;
          } else if (item.value == null && ik?.comment) {
            comment = ik.comment;
          }
        }
        if (comment)
          reqNewline = true;
        let str3 = stringify.stringify(item, itemCtx, () => comment = null);
        reqNewline || (reqNewline = lines.length > linesAtValue || str3.includes("\n"));
        if (i < items2.length - 1) {
          str3 += ",";
        } else if (ctx.options.trailingComma) {
          if (ctx.options.lineWidth > 0) {
            reqNewline || (reqNewline = lines.reduce((sum, line2) => sum + line2.length + 2, 2) + (str3.length + 2) > ctx.options.lineWidth);
          }
          if (reqNewline) {
            str3 += ",";
          }
        }
        if (comment)
          str3 += stringifyComment.lineComment(str3, itemIndent, commentString(comment));
        lines.push(str3);
        linesAtValue = lines.length;
      }
      const { start, end } = flowChars;
      if (lines.length === 0) {
        return start + end;
      } else {
        if (!reqNewline) {
          const len = lines.reduce((sum, line2) => sum + line2.length + 2, 2);
          reqNewline = ctx.options.lineWidth > 0 && len > ctx.options.lineWidth;
        }
        if (reqNewline) {
          let str3 = start;
          for (const line2 of lines)
            str3 += line2 ? `
${indentStep}${indent}${line2}` : "\n";
          return `${str3}
${indent}${end}`;
        } else {
          return `${start}${fcPadding}${lines.join(" ")}${fcPadding}${end}`;
        }
      }
    }
    function addCommentBefore({ indent, options: { commentString } }, lines, comment, chompKeep) {
      if (comment && chompKeep)
        comment = comment.replace(/^\n+/, "");
      if (comment) {
        const ic = stringifyComment.indentComment(commentString(comment), indent);
        lines.push(ic.trimStart());
      }
    }
    exports2.stringifyCollection = stringifyCollection;
  }
});

// ../../node_modules/yaml/dist/nodes/YAMLMap.js
var require_YAMLMap = __commonJS({
  "../../node_modules/yaml/dist/nodes/YAMLMap.js"(exports2) {
    "use strict";
    var stringifyCollection = require_stringifyCollection();
    var addPairToJSMap = require_addPairToJSMap();
    var Collection = require_Collection();
    var identity = require_identity();
    var Pair = require_Pair();
    var Scalar2 = require_Scalar();
    function findPair(items2, key) {
      const k = identity.isScalar(key) ? key.value : key;
      for (const it of items2) {
        if (identity.isPair(it)) {
          if (it.key === key || it.key === k)
            return it;
          if (identity.isScalar(it.key) && it.key.value === k)
            return it;
        }
      }
      return void 0;
    }
    var YAMLMap = class extends Collection.Collection {
      static get tagName() {
        return "tag:yaml.org,2002:map";
      }
      constructor(schema) {
        super(identity.MAP, schema);
        this.items = [];
      }
      /**
       * A generic collection parsing method that can be extended
       * to other node classes that inherit from YAMLMap
       */
      static from(schema, obj, ctx) {
        const { keepUndefined, replacer } = ctx;
        const map = new this(schema);
        const add = (key, value) => {
          if (typeof replacer === "function")
            value = replacer.call(obj, key, value);
          else if (Array.isArray(replacer) && !replacer.includes(key))
            return;
          if (value !== void 0 || keepUndefined)
            map.items.push(Pair.createPair(key, value, ctx));
        };
        if (obj instanceof Map) {
          for (const [key, value] of obj)
            add(key, value);
        } else if (obj && typeof obj === "object") {
          for (const key of Object.keys(obj))
            add(key, obj[key]);
        }
        if (typeof schema.sortMapEntries === "function") {
          map.items.sort(schema.sortMapEntries);
        }
        return map;
      }
      /**
       * Adds a value to the collection.
       *
       * @param overwrite - If not set `true`, using a key that is already in the
       *   collection will throw. Otherwise, overwrites the previous value.
       */
      add(pair, overwrite) {
        let _pair;
        if (identity.isPair(pair))
          _pair = pair;
        else if (!pair || typeof pair !== "object" || !("key" in pair)) {
          _pair = new Pair.Pair(pair, pair?.value);
        } else
          _pair = new Pair.Pair(pair.key, pair.value);
        const prev = findPair(this.items, _pair.key);
        const sortEntries = this.schema?.sortMapEntries;
        if (prev) {
          if (!overwrite)
            throw new Error(`Key ${_pair.key} already set`);
          if (identity.isScalar(prev.value) && Scalar2.isScalarValue(_pair.value))
            prev.value.value = _pair.value;
          else
            prev.value = _pair.value;
        } else if (sortEntries) {
          const i = this.items.findIndex((item) => sortEntries(_pair, item) < 0);
          if (i === -1)
            this.items.push(_pair);
          else
            this.items.splice(i, 0, _pair);
        } else {
          this.items.push(_pair);
        }
      }
      delete(key) {
        const it = findPair(this.items, key);
        if (!it)
          return false;
        const del = this.items.splice(this.items.indexOf(it), 1);
        return del.length > 0;
      }
      get(key, keepScalar) {
        const it = findPair(this.items, key);
        const node = it?.value;
        return (!keepScalar && identity.isScalar(node) ? node.value : node) ?? void 0;
      }
      has(key) {
        return !!findPair(this.items, key);
      }
      set(key, value) {
        this.add(new Pair.Pair(key, value), true);
      }
      /**
       * @param ctx - Conversion context, originally set in Document#toJS()
       * @param {Class} Type - If set, forces the returned collection type
       * @returns Instance of Type, Map, or Object
       */
      toJSON(_, ctx, Type) {
        const map = Type ? new Type() : ctx?.mapAsMap ? /* @__PURE__ */ new Map() : {};
        if (ctx?.onCreate)
          ctx.onCreate(map);
        for (const item of this.items)
          addPairToJSMap.addPairToJSMap(ctx, map, item);
        return map;
      }
      toString(ctx, onComment, onChompKeep) {
        if (!ctx)
          return JSON.stringify(this);
        for (const item of this.items) {
          if (!identity.isPair(item))
            throw new Error(`Map items must all be pairs; found ${JSON.stringify(item)} instead`);
        }
        if (!ctx.allNullValues && this.hasAllNullValues(false))
          ctx = Object.assign({}, ctx, { allNullValues: true });
        return stringifyCollection.stringifyCollection(this, ctx, {
          blockItemPrefix: "",
          flowChars: { start: "{", end: "}" },
          itemIndent: ctx.indent || "",
          onChompKeep,
          onComment
        });
      }
    };
    exports2.YAMLMap = YAMLMap;
    exports2.findPair = findPair;
  }
});

// ../../node_modules/yaml/dist/schema/common/map.js
var require_map = __commonJS({
  "../../node_modules/yaml/dist/schema/common/map.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var YAMLMap = require_YAMLMap();
    var map = {
      collection: "map",
      default: true,
      nodeClass: YAMLMap.YAMLMap,
      tag: "tag:yaml.org,2002:map",
      resolve(map2, onError) {
        if (!identity.isMap(map2))
          onError("Expected a mapping for this tag");
        return map2;
      },
      createNode: (schema, obj, ctx) => YAMLMap.YAMLMap.from(schema, obj, ctx)
    };
    exports2.map = map;
  }
});

// ../../node_modules/yaml/dist/nodes/YAMLSeq.js
var require_YAMLSeq = __commonJS({
  "../../node_modules/yaml/dist/nodes/YAMLSeq.js"(exports2) {
    "use strict";
    var createNode = require_createNode();
    var stringifyCollection = require_stringifyCollection();
    var Collection = require_Collection();
    var identity = require_identity();
    var Scalar2 = require_Scalar();
    var toJS = require_toJS();
    var YAMLSeq = class extends Collection.Collection {
      static get tagName() {
        return "tag:yaml.org,2002:seq";
      }
      constructor(schema) {
        super(identity.SEQ, schema);
        this.items = [];
      }
      add(value) {
        this.items.push(value);
      }
      /**
       * Removes a value from the collection.
       *
       * `key` must contain a representation of an integer for this to succeed.
       * It may be wrapped in a `Scalar`.
       *
       * @returns `true` if the item was found and removed.
       */
      delete(key) {
        const idx = asItemIndex(key);
        if (typeof idx !== "number")
          return false;
        const del = this.items.splice(idx, 1);
        return del.length > 0;
      }
      get(key, keepScalar) {
        const idx = asItemIndex(key);
        if (typeof idx !== "number")
          return void 0;
        const it = this.items[idx];
        return !keepScalar && identity.isScalar(it) ? it.value : it;
      }
      /**
       * Checks if the collection includes a value with the key `key`.
       *
       * `key` must contain a representation of an integer for this to succeed.
       * It may be wrapped in a `Scalar`.
       */
      has(key) {
        const idx = asItemIndex(key);
        return typeof idx === "number" && idx < this.items.length;
      }
      /**
       * Sets a value in this collection. For `!!set`, `value` needs to be a
       * boolean to add/remove the item from the set.
       *
       * If `key` does not contain a representation of an integer, this will throw.
       * It may be wrapped in a `Scalar`.
       */
      set(key, value) {
        const idx = asItemIndex(key);
        if (typeof idx !== "number")
          throw new Error(`Expected a valid index, not ${key}.`);
        const prev = this.items[idx];
        if (identity.isScalar(prev) && Scalar2.isScalarValue(value))
          prev.value = value;
        else
          this.items[idx] = value;
      }
      toJSON(_, ctx) {
        const seq = [];
        if (ctx?.onCreate)
          ctx.onCreate(seq);
        let i = 0;
        for (const item of this.items)
          seq.push(toJS.toJS(item, String(i++), ctx));
        return seq;
      }
      toString(ctx, onComment, onChompKeep) {
        if (!ctx)
          return JSON.stringify(this);
        return stringifyCollection.stringifyCollection(this, ctx, {
          blockItemPrefix: "- ",
          flowChars: { start: "[", end: "]" },
          itemIndent: (ctx.indent || "") + "  ",
          onChompKeep,
          onComment
        });
      }
      static from(schema, obj, ctx) {
        const { replacer } = ctx;
        const seq = new this(schema);
        if (obj && Symbol.iterator in Object(obj)) {
          let i = 0;
          for (let it of obj) {
            if (typeof replacer === "function") {
              const key = obj instanceof Set ? it : String(i++);
              it = replacer.call(obj, key, it);
            }
            seq.items.push(createNode.createNode(it, void 0, ctx));
          }
        }
        return seq;
      }
    };
    function asItemIndex(key) {
      let idx = identity.isScalar(key) ? key.value : key;
      if (idx && typeof idx === "string")
        idx = Number(idx);
      return typeof idx === "number" && Number.isInteger(idx) && idx >= 0 ? idx : null;
    }
    exports2.YAMLSeq = YAMLSeq;
  }
});

// ../../node_modules/yaml/dist/schema/common/seq.js
var require_seq = __commonJS({
  "../../node_modules/yaml/dist/schema/common/seq.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var YAMLSeq = require_YAMLSeq();
    var seq = {
      collection: "seq",
      default: true,
      nodeClass: YAMLSeq.YAMLSeq,
      tag: "tag:yaml.org,2002:seq",
      resolve(seq2, onError) {
        if (!identity.isSeq(seq2))
          onError("Expected a sequence for this tag");
        return seq2;
      },
      createNode: (schema, obj, ctx) => YAMLSeq.YAMLSeq.from(schema, obj, ctx)
    };
    exports2.seq = seq;
  }
});

// ../../node_modules/yaml/dist/schema/common/string.js
var require_string = __commonJS({
  "../../node_modules/yaml/dist/schema/common/string.js"(exports2) {
    "use strict";
    var stringifyString = require_stringifyString();
    var string = {
      identify: (value) => typeof value === "string",
      default: true,
      tag: "tag:yaml.org,2002:str",
      resolve: (str3) => str3,
      stringify(item, ctx, onComment, onChompKeep) {
        ctx = Object.assign({ actualString: true }, ctx);
        return stringifyString.stringifyString(item, ctx, onComment, onChompKeep);
      }
    };
    exports2.string = string;
  }
});

// ../../node_modules/yaml/dist/schema/common/null.js
var require_null = __commonJS({
  "../../node_modules/yaml/dist/schema/common/null.js"(exports2) {
    "use strict";
    var Scalar2 = require_Scalar();
    var nullTag = {
      identify: (value) => value == null,
      createNode: () => new Scalar2.Scalar(null),
      default: true,
      tag: "tag:yaml.org,2002:null",
      test: /^(?:~|[Nn]ull|NULL)?$/,
      resolve: () => new Scalar2.Scalar(null),
      stringify: ({ source }, ctx) => typeof source === "string" && nullTag.test.test(source) ? source : ctx.options.nullStr
    };
    exports2.nullTag = nullTag;
  }
});

// ../../node_modules/yaml/dist/schema/core/bool.js
var require_bool = __commonJS({
  "../../node_modules/yaml/dist/schema/core/bool.js"(exports2) {
    "use strict";
    var Scalar2 = require_Scalar();
    var boolTag = {
      identify: (value) => typeof value === "boolean",
      default: true,
      tag: "tag:yaml.org,2002:bool",
      test: /^(?:[Tt]rue|TRUE|[Ff]alse|FALSE)$/,
      resolve: (str3) => new Scalar2.Scalar(str3[0] === "t" || str3[0] === "T"),
      stringify({ source, value }, ctx) {
        if (source && boolTag.test.test(source)) {
          const sv = source[0] === "t" || source[0] === "T";
          if (value === sv)
            return source;
        }
        return value ? ctx.options.trueStr : ctx.options.falseStr;
      }
    };
    exports2.boolTag = boolTag;
  }
});

// ../../node_modules/yaml/dist/stringify/stringifyNumber.js
var require_stringifyNumber = __commonJS({
  "../../node_modules/yaml/dist/stringify/stringifyNumber.js"(exports2) {
    "use strict";
    function stringifyNumber({ format, minFractionDigits, tag, value }) {
      if (typeof value === "bigint")
        return String(value);
      const num = typeof value === "number" ? value : Number(value);
      if (!isFinite(num))
        return isNaN(num) ? ".nan" : num < 0 ? "-.inf" : ".inf";
      let n = Object.is(value, -0) ? "-0" : JSON.stringify(value);
      if (!format && minFractionDigits && (!tag || tag === "tag:yaml.org,2002:float") && /^-?\d/.test(n) && !n.includes("e")) {
        let i = n.indexOf(".");
        if (i < 0) {
          i = n.length;
          n += ".";
        }
        let d = minFractionDigits - (n.length - i - 1);
        while (d-- > 0)
          n += "0";
      }
      return n;
    }
    exports2.stringifyNumber = stringifyNumber;
  }
});

// ../../node_modules/yaml/dist/schema/core/float.js
var require_float = __commonJS({
  "../../node_modules/yaml/dist/schema/core/float.js"(exports2) {
    "use strict";
    var Scalar2 = require_Scalar();
    var stringifyNumber = require_stringifyNumber();
    var floatNaN = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      test: /^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/,
      resolve: (str3) => str3.slice(-3).toLowerCase() === "nan" ? NaN : str3[0] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY,
      stringify: stringifyNumber.stringifyNumber
    };
    var floatExp = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      format: "EXP",
      test: /^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)[eE][-+]?[0-9]+$/,
      resolve: (str3) => parseFloat(str3),
      stringify(node) {
        const num = Number(node.value);
        return isFinite(num) ? num.toExponential() : stringifyNumber.stringifyNumber(node);
      }
    };
    var float2 = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      test: /^[-+]?(?:\.[0-9]+|[0-9]+\.[0-9]*)$/,
      resolve(str3) {
        const node = new Scalar2.Scalar(parseFloat(str3));
        const dot = str3.indexOf(".");
        if (dot !== -1 && str3[str3.length - 1] === "0")
          node.minFractionDigits = str3.length - dot - 1;
        return node;
      },
      stringify: stringifyNumber.stringifyNumber
    };
    exports2.float = float2;
    exports2.floatExp = floatExp;
    exports2.floatNaN = floatNaN;
  }
});

// ../../node_modules/yaml/dist/schema/core/int.js
var require_int = __commonJS({
  "../../node_modules/yaml/dist/schema/core/int.js"(exports2) {
    "use strict";
    var stringifyNumber = require_stringifyNumber();
    var intIdentify = (value) => typeof value === "bigint" || Number.isInteger(value);
    var intResolve = (str3, offset, radix, { intAsBigInt }) => intAsBigInt ? BigInt(str3) : parseInt(str3.substring(offset), radix);
    function intStringify(node, radix, prefix) {
      const { value } = node;
      if (intIdentify(value) && value >= 0)
        return prefix + value.toString(radix);
      return stringifyNumber.stringifyNumber(node);
    }
    var intOct = {
      identify: (value) => intIdentify(value) && value >= 0,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "OCT",
      test: /^0o[0-7]+$/,
      resolve: (str3, _onError, opt) => intResolve(str3, 2, 8, opt),
      stringify: (node) => intStringify(node, 8, "0o")
    };
    var int3 = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      test: /^[-+]?[0-9]+$/,
      resolve: (str3, _onError, opt) => intResolve(str3, 0, 10, opt),
      stringify: stringifyNumber.stringifyNumber
    };
    var intHex = {
      identify: (value) => intIdentify(value) && value >= 0,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "HEX",
      test: /^0x[0-9a-fA-F]+$/,
      resolve: (str3, _onError, opt) => intResolve(str3, 2, 16, opt),
      stringify: (node) => intStringify(node, 16, "0x")
    };
    exports2.int = int3;
    exports2.intHex = intHex;
    exports2.intOct = intOct;
  }
});

// ../../node_modules/yaml/dist/schema/core/schema.js
var require_schema = __commonJS({
  "../../node_modules/yaml/dist/schema/core/schema.js"(exports2) {
    "use strict";
    var map = require_map();
    var _null = require_null();
    var seq = require_seq();
    var string = require_string();
    var bool = require_bool();
    var float2 = require_float();
    var int3 = require_int();
    var schema = [
      map.map,
      seq.seq,
      string.string,
      _null.nullTag,
      bool.boolTag,
      int3.intOct,
      int3.int,
      int3.intHex,
      float2.floatNaN,
      float2.floatExp,
      float2.float
    ];
    exports2.schema = schema;
  }
});

// ../../node_modules/yaml/dist/schema/json/schema.js
var require_schema2 = __commonJS({
  "../../node_modules/yaml/dist/schema/json/schema.js"(exports2) {
    "use strict";
    var Scalar2 = require_Scalar();
    var map = require_map();
    var seq = require_seq();
    function intIdentify(value) {
      return typeof value === "bigint" || Number.isInteger(value);
    }
    var stringifyJSON = ({ value }) => JSON.stringify(value);
    var jsonScalars = [
      {
        identify: (value) => typeof value === "string",
        default: true,
        tag: "tag:yaml.org,2002:str",
        resolve: (str3) => str3,
        stringify: stringifyJSON
      },
      {
        identify: (value) => value == null,
        createNode: () => new Scalar2.Scalar(null),
        default: true,
        tag: "tag:yaml.org,2002:null",
        test: /^null$/,
        resolve: () => null,
        stringify: stringifyJSON
      },
      {
        identify: (value) => typeof value === "boolean",
        default: true,
        tag: "tag:yaml.org,2002:bool",
        test: /^true$|^false$/,
        resolve: (str3) => str3 === "true",
        stringify: stringifyJSON
      },
      {
        identify: intIdentify,
        default: true,
        tag: "tag:yaml.org,2002:int",
        test: /^-?(?:0|[1-9][0-9]*)$/,
        resolve: (str3, _onError, { intAsBigInt }) => intAsBigInt ? BigInt(str3) : parseInt(str3, 10),
        stringify: ({ value }) => intIdentify(value) ? value.toString() : JSON.stringify(value)
      },
      {
        identify: (value) => typeof value === "number",
        default: true,
        tag: "tag:yaml.org,2002:float",
        test: /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]*)?(?:[eE][-+]?[0-9]+)?$/,
        resolve: (str3) => parseFloat(str3),
        stringify: stringifyJSON
      }
    ];
    var jsonError = {
      default: true,
      tag: "",
      test: /^/,
      resolve(str3, onError) {
        onError(`Unresolved plain scalar ${JSON.stringify(str3)}`);
        return str3;
      }
    };
    var schema = [map.map, seq.seq].concat(jsonScalars, jsonError);
    exports2.schema = schema;
  }
});

// ../../node_modules/yaml/dist/schema/yaml-1.1/binary.js
var require_binary = __commonJS({
  "../../node_modules/yaml/dist/schema/yaml-1.1/binary.js"(exports2) {
    "use strict";
    var node_buffer = require("buffer");
    var Scalar2 = require_Scalar();
    var stringifyString = require_stringifyString();
    var binary = {
      identify: (value) => value instanceof Uint8Array,
      // Buffer inherits from Uint8Array
      default: false,
      tag: "tag:yaml.org,2002:binary",
      /**
       * Returns a Buffer in node and an Uint8Array in browsers
       *
       * To use the resulting buffer as an image, you'll want to do something like:
       *
       *   const blob = new Blob([buffer], { type: 'image/jpeg' })
       *   document.querySelector('#photo').src = URL.createObjectURL(blob)
       */
      resolve(src, onError) {
        if (typeof node_buffer.Buffer === "function") {
          return node_buffer.Buffer.from(src, "base64");
        } else if (typeof atob === "function") {
          const str3 = atob(src.replace(/[\n\r]/g, ""));
          const buffer = new Uint8Array(str3.length);
          for (let i = 0; i < str3.length; ++i)
            buffer[i] = str3.charCodeAt(i);
          return buffer;
        } else {
          onError("This environment does not support reading binary tags; either Buffer or atob is required");
          return src;
        }
      },
      stringify({ comment, type, value }, ctx, onComment, onChompKeep) {
        if (!value)
          return "";
        const buf = value;
        let str3;
        if (typeof node_buffer.Buffer === "function") {
          str3 = buf instanceof node_buffer.Buffer ? buf.toString("base64") : node_buffer.Buffer.from(buf.buffer).toString("base64");
        } else if (typeof btoa === "function") {
          let s = "";
          for (let i = 0; i < buf.length; ++i)
            s += String.fromCharCode(buf[i]);
          str3 = btoa(s);
        } else {
          throw new Error("This environment does not support writing binary tags; either Buffer or btoa is required");
        }
        type ?? (type = Scalar2.Scalar.BLOCK_LITERAL);
        if (type !== Scalar2.Scalar.QUOTE_DOUBLE) {
          const lineWidth = Math.max(ctx.options.lineWidth - ctx.indent.length, ctx.options.minContentWidth);
          const n = Math.ceil(str3.length / lineWidth);
          const lines = new Array(n);
          for (let i = 0, o = 0; i < n; ++i, o += lineWidth) {
            lines[i] = str3.substr(o, lineWidth);
          }
          str3 = lines.join(type === Scalar2.Scalar.BLOCK_LITERAL ? "\n" : " ");
        }
        return stringifyString.stringifyString({ comment, type, value: str3 }, ctx, onComment, onChompKeep);
      }
    };
    exports2.binary = binary;
  }
});

// ../../node_modules/yaml/dist/schema/yaml-1.1/pairs.js
var require_pairs = __commonJS({
  "../../node_modules/yaml/dist/schema/yaml-1.1/pairs.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var Pair = require_Pair();
    var Scalar2 = require_Scalar();
    var YAMLSeq = require_YAMLSeq();
    function resolvePairs(seq, onError) {
      if (identity.isSeq(seq)) {
        for (let i = 0; i < seq.items.length; ++i) {
          let item = seq.items[i];
          if (identity.isPair(item))
            continue;
          else if (identity.isMap(item)) {
            if (item.items.length > 1)
              onError("Each pair must have its own sequence indicator");
            const pair = item.items[0] || new Pair.Pair(new Scalar2.Scalar(null));
            if (item.commentBefore)
              pair.key.commentBefore = pair.key.commentBefore ? `${item.commentBefore}
${pair.key.commentBefore}` : item.commentBefore;
            if (item.comment) {
              const cn = pair.value ?? pair.key;
              cn.comment = cn.comment ? `${item.comment}
${cn.comment}` : item.comment;
            }
            item = pair;
          }
          seq.items[i] = identity.isPair(item) ? item : new Pair.Pair(item);
        }
      } else
        onError("Expected a sequence for this tag");
      return seq;
    }
    function createPairs(schema, iterable, ctx) {
      const { replacer } = ctx;
      const pairs2 = new YAMLSeq.YAMLSeq(schema);
      pairs2.tag = "tag:yaml.org,2002:pairs";
      let i = 0;
      if (iterable && Symbol.iterator in Object(iterable))
        for (let it of iterable) {
          if (typeof replacer === "function")
            it = replacer.call(iterable, String(i++), it);
          let key, value;
          if (Array.isArray(it)) {
            if (it.length === 2) {
              key = it[0];
              value = it[1];
            } else
              throw new TypeError(`Expected [key, value] tuple: ${it}`);
          } else if (it && it instanceof Object) {
            const keys = Object.keys(it);
            if (keys.length === 1) {
              key = keys[0];
              value = it[key];
            } else {
              throw new TypeError(`Expected tuple with one key, not ${keys.length} keys`);
            }
          } else {
            key = it;
          }
          pairs2.items.push(Pair.createPair(key, value, ctx));
        }
      return pairs2;
    }
    var pairs = {
      collection: "seq",
      default: false,
      tag: "tag:yaml.org,2002:pairs",
      resolve: resolvePairs,
      createNode: createPairs
    };
    exports2.createPairs = createPairs;
    exports2.pairs = pairs;
    exports2.resolvePairs = resolvePairs;
  }
});

// ../../node_modules/yaml/dist/schema/yaml-1.1/omap.js
var require_omap = __commonJS({
  "../../node_modules/yaml/dist/schema/yaml-1.1/omap.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var toJS = require_toJS();
    var YAMLMap = require_YAMLMap();
    var YAMLSeq = require_YAMLSeq();
    var pairs = require_pairs();
    var YAMLOMap = class _YAMLOMap extends YAMLSeq.YAMLSeq {
      constructor() {
        super();
        this.add = YAMLMap.YAMLMap.prototype.add.bind(this);
        this.delete = YAMLMap.YAMLMap.prototype.delete.bind(this);
        this.get = YAMLMap.YAMLMap.prototype.get.bind(this);
        this.has = YAMLMap.YAMLMap.prototype.has.bind(this);
        this.set = YAMLMap.YAMLMap.prototype.set.bind(this);
        this.tag = _YAMLOMap.tag;
      }
      /**
       * If `ctx` is given, the return type is actually `Map<unknown, unknown>`,
       * but TypeScript won't allow widening the signature of a child method.
       */
      toJSON(_, ctx) {
        if (!ctx)
          return super.toJSON(_);
        const map = /* @__PURE__ */ new Map();
        if (ctx?.onCreate)
          ctx.onCreate(map);
        for (const pair of this.items) {
          let key, value;
          if (identity.isPair(pair)) {
            key = toJS.toJS(pair.key, "", ctx);
            value = toJS.toJS(pair.value, key, ctx);
          } else {
            key = toJS.toJS(pair, "", ctx);
          }
          if (map.has(key))
            throw new Error("Ordered maps must not include duplicate keys");
          map.set(key, value);
        }
        return map;
      }
      static from(schema, iterable, ctx) {
        const pairs$1 = pairs.createPairs(schema, iterable, ctx);
        const omap2 = new this();
        omap2.items = pairs$1.items;
        return omap2;
      }
    };
    YAMLOMap.tag = "tag:yaml.org,2002:omap";
    var omap = {
      collection: "seq",
      identify: (value) => value instanceof Map,
      nodeClass: YAMLOMap,
      default: false,
      tag: "tag:yaml.org,2002:omap",
      resolve(seq, onError) {
        const pairs$1 = pairs.resolvePairs(seq, onError);
        const seenKeys = [];
        for (const { key } of pairs$1.items) {
          if (identity.isScalar(key)) {
            if (seenKeys.includes(key.value)) {
              onError(`Ordered maps must not include duplicate keys: ${key.value}`);
            } else {
              seenKeys.push(key.value);
            }
          }
        }
        return Object.assign(new YAMLOMap(), pairs$1);
      },
      createNode: (schema, iterable, ctx) => YAMLOMap.from(schema, iterable, ctx)
    };
    exports2.YAMLOMap = YAMLOMap;
    exports2.omap = omap;
  }
});

// ../../node_modules/yaml/dist/schema/yaml-1.1/bool.js
var require_bool2 = __commonJS({
  "../../node_modules/yaml/dist/schema/yaml-1.1/bool.js"(exports2) {
    "use strict";
    var Scalar2 = require_Scalar();
    function boolStringify({ value, source }, ctx) {
      const boolObj = value ? trueTag : falseTag;
      if (source && boolObj.test.test(source))
        return source;
      return value ? ctx.options.trueStr : ctx.options.falseStr;
    }
    var trueTag = {
      identify: (value) => value === true,
      default: true,
      tag: "tag:yaml.org,2002:bool",
      test: /^(?:Y|y|[Yy]es|YES|[Tt]rue|TRUE|[Oo]n|ON)$/,
      resolve: () => new Scalar2.Scalar(true),
      stringify: boolStringify
    };
    var falseTag = {
      identify: (value) => value === false,
      default: true,
      tag: "tag:yaml.org,2002:bool",
      test: /^(?:N|n|[Nn]o|NO|[Ff]alse|FALSE|[Oo]ff|OFF)$/,
      resolve: () => new Scalar2.Scalar(false),
      stringify: boolStringify
    };
    exports2.falseTag = falseTag;
    exports2.trueTag = trueTag;
  }
});

// ../../node_modules/yaml/dist/schema/yaml-1.1/float.js
var require_float2 = __commonJS({
  "../../node_modules/yaml/dist/schema/yaml-1.1/float.js"(exports2) {
    "use strict";
    var Scalar2 = require_Scalar();
    var stringifyNumber = require_stringifyNumber();
    var floatNaN = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      test: /^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/,
      resolve: (str3) => str3.slice(-3).toLowerCase() === "nan" ? NaN : str3[0] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY,
      stringify: stringifyNumber.stringifyNumber
    };
    var floatExp = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      format: "EXP",
      test: /^[-+]?(?:[0-9][0-9_]*)?(?:\.[0-9_]*)?[eE][-+]?[0-9]+$/,
      resolve: (str3) => parseFloat(str3.replace(/_/g, "")),
      stringify(node) {
        const num = Number(node.value);
        return isFinite(num) ? num.toExponential() : stringifyNumber.stringifyNumber(node);
      }
    };
    var float2 = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      test: /^[-+]?(?:[0-9][0-9_]*)?\.[0-9_]*$/,
      resolve(str3) {
        const node = new Scalar2.Scalar(parseFloat(str3.replace(/_/g, "")));
        const dot = str3.indexOf(".");
        if (dot !== -1) {
          const f = str3.substring(dot + 1).replace(/_/g, "");
          if (f[f.length - 1] === "0")
            node.minFractionDigits = f.length;
        }
        return node;
      },
      stringify: stringifyNumber.stringifyNumber
    };
    exports2.float = float2;
    exports2.floatExp = floatExp;
    exports2.floatNaN = floatNaN;
  }
});

// ../../node_modules/yaml/dist/schema/yaml-1.1/int.js
var require_int2 = __commonJS({
  "../../node_modules/yaml/dist/schema/yaml-1.1/int.js"(exports2) {
    "use strict";
    var stringifyNumber = require_stringifyNumber();
    var intIdentify = (value) => typeof value === "bigint" || Number.isInteger(value);
    function intResolve(str3, offset, radix, { intAsBigInt }) {
      const sign = str3[0];
      if (sign === "-" || sign === "+")
        offset += 1;
      str3 = str3.substring(offset).replace(/_/g, "");
      if (intAsBigInt) {
        switch (radix) {
          case 2:
            str3 = `0b${str3}`;
            break;
          case 8:
            str3 = `0o${str3}`;
            break;
          case 16:
            str3 = `0x${str3}`;
            break;
        }
        const n2 = BigInt(str3);
        return sign === "-" ? BigInt(-1) * n2 : n2;
      }
      const n = parseInt(str3, radix);
      return sign === "-" ? -1 * n : n;
    }
    function intStringify(node, radix, prefix) {
      const { value } = node;
      if (intIdentify(value)) {
        const str3 = value.toString(radix);
        return value < 0 ? "-" + prefix + str3.substr(1) : prefix + str3;
      }
      return stringifyNumber.stringifyNumber(node);
    }
    var intBin = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "BIN",
      test: /^[-+]?0b[0-1_]+$/,
      resolve: (str3, _onError, opt) => intResolve(str3, 2, 2, opt),
      stringify: (node) => intStringify(node, 2, "0b")
    };
    var intOct = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "OCT",
      test: /^[-+]?0[0-7_]+$/,
      resolve: (str3, _onError, opt) => intResolve(str3, 1, 8, opt),
      stringify: (node) => intStringify(node, 8, "0")
    };
    var int3 = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      test: /^[-+]?[0-9][0-9_]*$/,
      resolve: (str3, _onError, opt) => intResolve(str3, 0, 10, opt),
      stringify: stringifyNumber.stringifyNumber
    };
    var intHex = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "HEX",
      test: /^[-+]?0x[0-9a-fA-F_]+$/,
      resolve: (str3, _onError, opt) => intResolve(str3, 2, 16, opt),
      stringify: (node) => intStringify(node, 16, "0x")
    };
    exports2.int = int3;
    exports2.intBin = intBin;
    exports2.intHex = intHex;
    exports2.intOct = intOct;
  }
});

// ../../node_modules/yaml/dist/schema/yaml-1.1/set.js
var require_set = __commonJS({
  "../../node_modules/yaml/dist/schema/yaml-1.1/set.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var Pair = require_Pair();
    var YAMLMap = require_YAMLMap();
    var YAMLSet = class _YAMLSet extends YAMLMap.YAMLMap {
      constructor(schema) {
        super(schema);
        this.tag = _YAMLSet.tag;
      }
      add(key) {
        let pair;
        if (identity.isPair(key))
          pair = key;
        else if (key && typeof key === "object" && "key" in key && "value" in key && key.value === null)
          pair = new Pair.Pair(key.key, null);
        else
          pair = new Pair.Pair(key, null);
        const prev = YAMLMap.findPair(this.items, pair.key);
        if (!prev)
          this.items.push(pair);
      }
      /**
       * If `keepPair` is `true`, returns the Pair matching `key`.
       * Otherwise, returns the value of that Pair's key.
       */
      get(key, keepPair) {
        const pair = YAMLMap.findPair(this.items, key);
        return !keepPair && identity.isPair(pair) ? identity.isScalar(pair.key) ? pair.key.value : pair.key : pair;
      }
      set(key, value) {
        if (typeof value !== "boolean")
          throw new Error(`Expected boolean value for set(key, value) in a YAML set, not ${typeof value}`);
        const prev = YAMLMap.findPair(this.items, key);
        if (prev && !value) {
          this.items.splice(this.items.indexOf(prev), 1);
        } else if (!prev && value) {
          this.items.push(new Pair.Pair(key));
        }
      }
      toJSON(_, ctx) {
        return super.toJSON(_, ctx, Set);
      }
      toString(ctx, onComment, onChompKeep) {
        if (!ctx)
          return JSON.stringify(this);
        if (this.hasAllNullValues(true))
          return super.toString(Object.assign({}, ctx, { allNullValues: true }), onComment, onChompKeep);
        else
          throw new Error("Set items must all have null values");
      }
      static from(schema, iterable, ctx) {
        const { replacer } = ctx;
        const set2 = new this(schema);
        if (iterable && Symbol.iterator in Object(iterable))
          for (let value of iterable) {
            if (typeof replacer === "function")
              value = replacer.call(iterable, value, value);
            set2.items.push(Pair.createPair(value, null, ctx));
          }
        return set2;
      }
    };
    YAMLSet.tag = "tag:yaml.org,2002:set";
    var set = {
      collection: "map",
      identify: (value) => value instanceof Set,
      nodeClass: YAMLSet,
      default: false,
      tag: "tag:yaml.org,2002:set",
      createNode: (schema, iterable, ctx) => YAMLSet.from(schema, iterable, ctx),
      resolve(map, onError) {
        if (identity.isMap(map)) {
          if (map.hasAllNullValues(true))
            return Object.assign(new YAMLSet(), map);
          else
            onError("Set items must all have null values");
        } else
          onError("Expected a mapping for this tag");
        return map;
      }
    };
    exports2.YAMLSet = YAMLSet;
    exports2.set = set;
  }
});

// ../../node_modules/yaml/dist/schema/yaml-1.1/timestamp.js
var require_timestamp = __commonJS({
  "../../node_modules/yaml/dist/schema/yaml-1.1/timestamp.js"(exports2) {
    "use strict";
    var stringifyNumber = require_stringifyNumber();
    function parseSexagesimal(str3, asBigInt) {
      const sign = str3[0];
      const parts = sign === "-" || sign === "+" ? str3.substring(1) : str3;
      const num = (n) => asBigInt ? BigInt(n) : Number(n);
      const res = parts.replace(/_/g, "").split(":").reduce((res2, p) => res2 * num(60) + num(p), num(0));
      return sign === "-" ? num(-1) * res : res;
    }
    function stringifySexagesimal(node) {
      let { value } = node;
      let num = (n) => n;
      if (typeof value === "bigint")
        num = (n) => BigInt(n);
      else if (isNaN(value) || !isFinite(value))
        return stringifyNumber.stringifyNumber(node);
      let sign = "";
      if (value < 0) {
        sign = "-";
        value *= num(-1);
      }
      const _60 = num(60);
      const parts = [value % _60];
      if (value < 60) {
        parts.unshift(0);
      } else {
        value = (value - parts[0]) / _60;
        parts.unshift(value % _60);
        if (value >= 60) {
          value = (value - parts[0]) / _60;
          parts.unshift(value);
        }
      }
      return sign + parts.map((n) => String(n).padStart(2, "0")).join(":").replace(/000000\d*$/, "");
    }
    var intTime = {
      identify: (value) => typeof value === "bigint" || Number.isInteger(value),
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "TIME",
      test: /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+$/,
      resolve: (str3, _onError, { intAsBigInt }) => parseSexagesimal(str3, intAsBigInt),
      stringify: stringifySexagesimal
    };
    var floatTime = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      format: "TIME",
      test: /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*$/,
      resolve: (str3) => parseSexagesimal(str3, false),
      stringify: stringifySexagesimal
    };
    var timestamp = {
      identify: (value) => value instanceof Date,
      default: true,
      tag: "tag:yaml.org,2002:timestamp",
      // If the time zone is omitted, the timestamp is assumed to be specified in UTC. The time part
      // may be omitted altogether, resulting in a date format. In such a case, the time part is
      // assumed to be 00:00:00Z (start of day, UTC).
      test: RegExp("^([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})(?:(?:t|T|[ \\t]+)([0-9]{1,2}):([0-9]{1,2}):([0-9]{1,2}(\\.[0-9]+)?)(?:[ \\t]*(Z|[-+][012]?[0-9](?::[0-9]{2})?))?)?$"),
      resolve(str3) {
        const match = str3.match(timestamp.test);
        if (!match)
          throw new Error("!!timestamp expects a date, starting with yyyy-mm-dd");
        const [, year, month, day, hour, minute, second] = match.map(Number);
        const millisec = match[7] ? Number((match[7] + "00").substr(1, 3)) : 0;
        let date = Date.UTC(year, month - 1, day, hour || 0, minute || 0, second || 0, millisec);
        const tz = match[8];
        if (tz && tz !== "Z") {
          let d = parseSexagesimal(tz, false);
          if (Math.abs(d) < 30)
            d *= 60;
          date -= 6e4 * d;
        }
        return new Date(date);
      },
      stringify: ({ value }) => value?.toISOString().replace(/(T00:00:00)?\.000Z$/, "") ?? ""
    };
    exports2.floatTime = floatTime;
    exports2.intTime = intTime;
    exports2.timestamp = timestamp;
  }
});

// ../../node_modules/yaml/dist/schema/yaml-1.1/schema.js
var require_schema3 = __commonJS({
  "../../node_modules/yaml/dist/schema/yaml-1.1/schema.js"(exports2) {
    "use strict";
    var map = require_map();
    var _null = require_null();
    var seq = require_seq();
    var string = require_string();
    var binary = require_binary();
    var bool = require_bool2();
    var float2 = require_float2();
    var int3 = require_int2();
    var merge = require_merge();
    var omap = require_omap();
    var pairs = require_pairs();
    var set = require_set();
    var timestamp = require_timestamp();
    var schema = [
      map.map,
      seq.seq,
      string.string,
      _null.nullTag,
      bool.trueTag,
      bool.falseTag,
      int3.intBin,
      int3.intOct,
      int3.int,
      int3.intHex,
      float2.floatNaN,
      float2.floatExp,
      float2.float,
      binary.binary,
      merge.merge,
      omap.omap,
      pairs.pairs,
      set.set,
      timestamp.intTime,
      timestamp.floatTime,
      timestamp.timestamp
    ];
    exports2.schema = schema;
  }
});

// ../../node_modules/yaml/dist/schema/tags.js
var require_tags = __commonJS({
  "../../node_modules/yaml/dist/schema/tags.js"(exports2) {
    "use strict";
    var map = require_map();
    var _null = require_null();
    var seq = require_seq();
    var string = require_string();
    var bool = require_bool();
    var float2 = require_float();
    var int3 = require_int();
    var schema = require_schema();
    var schema$1 = require_schema2();
    var binary = require_binary();
    var merge = require_merge();
    var omap = require_omap();
    var pairs = require_pairs();
    var schema$2 = require_schema3();
    var set = require_set();
    var timestamp = require_timestamp();
    var schemas = /* @__PURE__ */ new Map([
      ["core", schema.schema],
      ["failsafe", [map.map, seq.seq, string.string]],
      ["json", schema$1.schema],
      ["yaml11", schema$2.schema],
      ["yaml-1.1", schema$2.schema]
    ]);
    var tagsByName = {
      binary: binary.binary,
      bool: bool.boolTag,
      float: float2.float,
      floatExp: float2.floatExp,
      floatNaN: float2.floatNaN,
      floatTime: timestamp.floatTime,
      int: int3.int,
      intHex: int3.intHex,
      intOct: int3.intOct,
      intTime: timestamp.intTime,
      map: map.map,
      merge: merge.merge,
      null: _null.nullTag,
      omap: omap.omap,
      pairs: pairs.pairs,
      seq: seq.seq,
      set: set.set,
      timestamp: timestamp.timestamp
    };
    var coreKnownTags = {
      "tag:yaml.org,2002:binary": binary.binary,
      "tag:yaml.org,2002:merge": merge.merge,
      "tag:yaml.org,2002:omap": omap.omap,
      "tag:yaml.org,2002:pairs": pairs.pairs,
      "tag:yaml.org,2002:set": set.set,
      "tag:yaml.org,2002:timestamp": timestamp.timestamp
    };
    function getTags(customTags, schemaName, addMergeTag) {
      const schemaTags = schemas.get(schemaName);
      if (schemaTags && !customTags) {
        return addMergeTag && !schemaTags.includes(merge.merge) ? schemaTags.concat(merge.merge) : schemaTags.slice();
      }
      let tags = schemaTags;
      if (!tags) {
        if (Array.isArray(customTags))
          tags = [];
        else {
          const keys = Array.from(schemas.keys()).filter((key) => key !== "yaml11").map((key) => JSON.stringify(key)).join(", ");
          throw new Error(`Unknown schema "${schemaName}"; use one of ${keys} or define customTags array`);
        }
      }
      if (Array.isArray(customTags)) {
        for (const tag of customTags)
          tags = tags.concat(tag);
      } else if (typeof customTags === "function") {
        tags = customTags(tags.slice());
      }
      if (addMergeTag)
        tags = tags.concat(merge.merge);
      return tags.reduce((tags2, tag) => {
        const tagObj = typeof tag === "string" ? tagsByName[tag] : tag;
        if (!tagObj) {
          const tagName = JSON.stringify(tag);
          const keys = Object.keys(tagsByName).map((key) => JSON.stringify(key)).join(", ");
          throw new Error(`Unknown custom tag ${tagName}; use one of ${keys}`);
        }
        if (!tags2.includes(tagObj))
          tags2.push(tagObj);
        return tags2;
      }, []);
    }
    exports2.coreKnownTags = coreKnownTags;
    exports2.getTags = getTags;
  }
});

// ../../node_modules/yaml/dist/schema/Schema.js
var require_Schema = __commonJS({
  "../../node_modules/yaml/dist/schema/Schema.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var map = require_map();
    var seq = require_seq();
    var string = require_string();
    var tags = require_tags();
    var sortMapEntriesByKey = (a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    var Schema = class _Schema {
      constructor({ compat, customTags, merge, resolveKnownTags, schema, sortMapEntries, toStringDefaults }) {
        this.compat = Array.isArray(compat) ? tags.getTags(compat, "compat") : compat ? tags.getTags(null, compat) : null;
        this.name = typeof schema === "string" && schema || "core";
        this.knownTags = resolveKnownTags ? tags.coreKnownTags : {};
        this.tags = tags.getTags(customTags, this.name, merge);
        this.toStringOptions = toStringDefaults ?? null;
        Object.defineProperty(this, identity.MAP, { value: map.map });
        Object.defineProperty(this, identity.SCALAR, { value: string.string });
        Object.defineProperty(this, identity.SEQ, { value: seq.seq });
        this.sortMapEntries = typeof sortMapEntries === "function" ? sortMapEntries : sortMapEntries === true ? sortMapEntriesByKey : null;
      }
      clone() {
        const copy = Object.create(_Schema.prototype, Object.getOwnPropertyDescriptors(this));
        copy.tags = this.tags.slice();
        return copy;
      }
    };
    exports2.Schema = Schema;
  }
});

// ../../node_modules/yaml/dist/stringify/stringifyDocument.js
var require_stringifyDocument = __commonJS({
  "../../node_modules/yaml/dist/stringify/stringifyDocument.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var stringify = require_stringify();
    var stringifyComment = require_stringifyComment();
    function stringifyDocument(doc, options) {
      const lines = [];
      let hasDirectives = options.directives === true;
      if (options.directives !== false && doc.directives) {
        const dir = doc.directives.toString(doc);
        if (dir) {
          lines.push(dir);
          hasDirectives = true;
        } else if (doc.directives.docStart)
          hasDirectives = true;
      }
      if (hasDirectives)
        lines.push("---");
      const ctx = stringify.createStringifyContext(doc, options);
      const { commentString } = ctx.options;
      if (doc.commentBefore) {
        if (lines.length !== 1)
          lines.unshift("");
        const cs = commentString(doc.commentBefore);
        lines.unshift(stringifyComment.indentComment(cs, ""));
      }
      let chompKeep = false;
      let contentComment = null;
      if (doc.contents) {
        if (identity.isNode(doc.contents)) {
          if (doc.contents.spaceBefore && hasDirectives)
            lines.push("");
          if (doc.contents.commentBefore) {
            const cs = commentString(doc.contents.commentBefore);
            lines.push(stringifyComment.indentComment(cs, ""));
          }
          ctx.forceBlockIndent = !!doc.comment;
          contentComment = doc.contents.comment;
        }
        const onChompKeep = contentComment ? void 0 : () => chompKeep = true;
        let body = stringify.stringify(doc.contents, ctx, () => contentComment = null, onChompKeep);
        if (contentComment)
          body += stringifyComment.lineComment(body, "", commentString(contentComment));
        if ((body[0] === "|" || body[0] === ">") && lines[lines.length - 1] === "---") {
          lines[lines.length - 1] = `--- ${body}`;
        } else
          lines.push(body);
      } else {
        lines.push(stringify.stringify(doc.contents, ctx));
      }
      if (doc.directives?.docEnd) {
        if (doc.comment) {
          const cs = commentString(doc.comment);
          if (cs.includes("\n")) {
            lines.push("...");
            lines.push(stringifyComment.indentComment(cs, ""));
          } else {
            lines.push(`... ${cs}`);
          }
        } else {
          lines.push("...");
        }
      } else {
        let dc = doc.comment;
        if (dc && chompKeep)
          dc = dc.replace(/^\n+/, "");
        if (dc) {
          if ((!chompKeep || contentComment) && lines[lines.length - 1] !== "")
            lines.push("");
          lines.push(stringifyComment.indentComment(commentString(dc), ""));
        }
      }
      return lines.join("\n") + "\n";
    }
    exports2.stringifyDocument = stringifyDocument;
  }
});

// ../../node_modules/yaml/dist/doc/Document.js
var require_Document = __commonJS({
  "../../node_modules/yaml/dist/doc/Document.js"(exports2) {
    "use strict";
    var Alias = require_Alias();
    var Collection = require_Collection();
    var identity = require_identity();
    var Pair = require_Pair();
    var toJS = require_toJS();
    var Schema = require_Schema();
    var stringifyDocument = require_stringifyDocument();
    var anchors = require_anchors();
    var applyReviver = require_applyReviver();
    var createNode = require_createNode();
    var directives = require_directives();
    var Document = class _Document {
      constructor(value, replacer, options) {
        this.commentBefore = null;
        this.comment = null;
        this.errors = [];
        this.warnings = [];
        Object.defineProperty(this, identity.NODE_TYPE, { value: identity.DOC });
        let _replacer = null;
        if (typeof replacer === "function" || Array.isArray(replacer)) {
          _replacer = replacer;
        } else if (options === void 0 && replacer) {
          options = replacer;
          replacer = void 0;
        }
        const opt = Object.assign({
          intAsBigInt: false,
          keepSourceTokens: false,
          logLevel: "warn",
          prettyErrors: true,
          strict: true,
          stringKeys: false,
          uniqueKeys: true,
          version: "1.2"
        }, options);
        this.options = opt;
        let { version } = opt;
        if (options?._directives) {
          this.directives = options._directives.atDocument();
          if (this.directives.yaml.explicit)
            version = this.directives.yaml.version;
        } else
          this.directives = new directives.Directives({ version });
        this.setSchema(version, options);
        this.contents = value === void 0 ? null : this.createNode(value, _replacer, options);
      }
      /**
       * Create a deep copy of this Document and its contents.
       *
       * Custom Node values that inherit from `Object` still refer to their original instances.
       */
      clone() {
        const copy = Object.create(_Document.prototype, {
          [identity.NODE_TYPE]: { value: identity.DOC }
        });
        copy.commentBefore = this.commentBefore;
        copy.comment = this.comment;
        copy.errors = this.errors.slice();
        copy.warnings = this.warnings.slice();
        copy.options = Object.assign({}, this.options);
        if (this.directives)
          copy.directives = this.directives.clone();
        copy.schema = this.schema.clone();
        copy.contents = identity.isNode(this.contents) ? this.contents.clone(copy.schema) : this.contents;
        if (this.range)
          copy.range = this.range.slice();
        return copy;
      }
      /** Adds a value to the document. */
      add(value) {
        if (assertCollection(this.contents))
          this.contents.add(value);
      }
      /** Adds a value to the document. */
      addIn(path27, value) {
        if (assertCollection(this.contents))
          this.contents.addIn(path27, value);
      }
      /**
       * Create a new `Alias` node, ensuring that the target `node` has the required anchor.
       *
       * If `node` already has an anchor, `name` is ignored.
       * Otherwise, the `node.anchor` value will be set to `name`,
       * or if an anchor with that name is already present in the document,
       * `name` will be used as a prefix for a new unique anchor.
       * If `name` is undefined, the generated anchor will use 'a' as a prefix.
       */
      createAlias(node, name) {
        if (!node.anchor) {
          const prev = anchors.anchorNames(this);
          node.anchor = // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
          !name || prev.has(name) ? anchors.findNewAnchor(name || "a", prev) : name;
        }
        return new Alias.Alias(node.anchor);
      }
      createNode(value, replacer, options) {
        let _replacer = void 0;
        if (typeof replacer === "function") {
          value = replacer.call({ "": value }, "", value);
          _replacer = replacer;
        } else if (Array.isArray(replacer)) {
          const keyToStr = (v) => typeof v === "number" || v instanceof String || v instanceof Number;
          const asStr = replacer.filter(keyToStr).map(String);
          if (asStr.length > 0)
            replacer = replacer.concat(asStr);
          _replacer = replacer;
        } else if (options === void 0 && replacer) {
          options = replacer;
          replacer = void 0;
        }
        const { aliasDuplicateObjects, anchorPrefix, flow, keepUndefined, onTagObj, tag } = options ?? {};
        const { onAnchor, setAnchors, sourceObjects } = anchors.createNodeAnchors(
          this,
          // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
          anchorPrefix || "a"
        );
        const ctx = {
          aliasDuplicateObjects: aliasDuplicateObjects ?? true,
          keepUndefined: keepUndefined ?? false,
          onAnchor,
          onTagObj,
          replacer: _replacer,
          schema: this.schema,
          sourceObjects
        };
        const node = createNode.createNode(value, tag, ctx);
        if (flow && identity.isCollection(node))
          node.flow = true;
        setAnchors();
        return node;
      }
      /**
       * Convert a key and a value into a `Pair` using the current schema,
       * recursively wrapping all values as `Scalar` or `Collection` nodes.
       */
      createPair(key, value, options = {}) {
        const k = this.createNode(key, null, options);
        const v = this.createNode(value, null, options);
        return new Pair.Pair(k, v);
      }
      /**
       * Removes a value from the document.
       * @returns `true` if the item was found and removed.
       */
      delete(key) {
        return assertCollection(this.contents) ? this.contents.delete(key) : false;
      }
      /**
       * Removes a value from the document.
       * @returns `true` if the item was found and removed.
       */
      deleteIn(path27) {
        if (Collection.isEmptyPath(path27)) {
          if (this.contents == null)
            return false;
          this.contents = null;
          return true;
        }
        return assertCollection(this.contents) ? this.contents.deleteIn(path27) : false;
      }
      /**
       * Returns item at `key`, or `undefined` if not found. By default unwraps
       * scalar values from their surrounding node; to disable set `keepScalar` to
       * `true` (collections are always returned intact).
       */
      get(key, keepScalar) {
        return identity.isCollection(this.contents) ? this.contents.get(key, keepScalar) : void 0;
      }
      /**
       * Returns item at `path`, or `undefined` if not found. By default unwraps
       * scalar values from their surrounding node; to disable set `keepScalar` to
       * `true` (collections are always returned intact).
       */
      getIn(path27, keepScalar) {
        if (Collection.isEmptyPath(path27))
          return !keepScalar && identity.isScalar(this.contents) ? this.contents.value : this.contents;
        return identity.isCollection(this.contents) ? this.contents.getIn(path27, keepScalar) : void 0;
      }
      /**
       * Checks if the document includes a value with the key `key`.
       */
      has(key) {
        return identity.isCollection(this.contents) ? this.contents.has(key) : false;
      }
      /**
       * Checks if the document includes a value at `path`.
       */
      hasIn(path27) {
        if (Collection.isEmptyPath(path27))
          return this.contents !== void 0;
        return identity.isCollection(this.contents) ? this.contents.hasIn(path27) : false;
      }
      /**
       * Sets a value in this document. For `!!set`, `value` needs to be a
       * boolean to add/remove the item from the set.
       */
      set(key, value) {
        if (this.contents == null) {
          this.contents = Collection.collectionFromPath(this.schema, [key], value);
        } else if (assertCollection(this.contents)) {
          this.contents.set(key, value);
        }
      }
      /**
       * Sets a value in this document. For `!!set`, `value` needs to be a
       * boolean to add/remove the item from the set.
       */
      setIn(path27, value) {
        if (Collection.isEmptyPath(path27)) {
          this.contents = value;
        } else if (this.contents == null) {
          this.contents = Collection.collectionFromPath(this.schema, Array.from(path27), value);
        } else if (assertCollection(this.contents)) {
          this.contents.setIn(path27, value);
        }
      }
      /**
       * Change the YAML version and schema used by the document.
       * A `null` version disables support for directives, explicit tags, anchors, and aliases.
       * It also requires the `schema` option to be given as a `Schema` instance value.
       *
       * Overrides all previously set schema options.
       */
      setSchema(version, options = {}) {
        if (typeof version === "number")
          version = String(version);
        let opt;
        switch (version) {
          case "1.1":
            if (this.directives)
              this.directives.yaml.version = "1.1";
            else
              this.directives = new directives.Directives({ version: "1.1" });
            opt = { resolveKnownTags: false, schema: "yaml-1.1" };
            break;
          case "1.2":
          case "next":
            if (this.directives)
              this.directives.yaml.version = version;
            else
              this.directives = new directives.Directives({ version });
            opt = { resolveKnownTags: true, schema: "core" };
            break;
          case null:
            if (this.directives)
              delete this.directives;
            opt = null;
            break;
          default: {
            const sv = JSON.stringify(version);
            throw new Error(`Expected '1.1', '1.2' or null as first argument, but found: ${sv}`);
          }
        }
        if (options.schema instanceof Object)
          this.schema = options.schema;
        else if (opt)
          this.schema = new Schema.Schema(Object.assign(opt, options));
        else
          throw new Error(`With a null YAML version, the { schema: Schema } option is required`);
      }
      // json & jsonArg are only used from toJSON()
      toJS({ json, jsonArg, mapAsMap, maxAliasCount, onAnchor, reviver } = {}) {
        const ctx = {
          anchors: /* @__PURE__ */ new Map(),
          doc: this,
          keep: !json,
          mapAsMap: mapAsMap === true,
          mapKeyWarned: false,
          maxAliasCount: typeof maxAliasCount === "number" ? maxAliasCount : 100
        };
        const res = toJS.toJS(this.contents, jsonArg ?? "", ctx);
        if (typeof onAnchor === "function")
          for (const { count, res: res2 } of ctx.anchors.values())
            onAnchor(res2, count);
        return typeof reviver === "function" ? applyReviver.applyReviver(reviver, { "": res }, "", res) : res;
      }
      /**
       * A JSON representation of the document `contents`.
       *
       * @param jsonArg Used by `JSON.stringify` to indicate the array index or
       *   property name.
       */
      toJSON(jsonArg, onAnchor) {
        return this.toJS({ json: true, jsonArg, mapAsMap: false, onAnchor });
      }
      /** A YAML representation of the document. */
      toString(options = {}) {
        if (this.errors.length > 0)
          throw new Error("Document with errors cannot be stringified");
        if ("indent" in options && (!Number.isInteger(options.indent) || Number(options.indent) <= 0)) {
          const s = JSON.stringify(options.indent);
          throw new Error(`"indent" option must be a positive integer, not ${s}`);
        }
        return stringifyDocument.stringifyDocument(this, options);
      }
    };
    function assertCollection(contents) {
      if (identity.isCollection(contents))
        return true;
      throw new Error("Expected a YAML collection as document contents");
    }
    exports2.Document = Document;
  }
});

// ../../node_modules/yaml/dist/errors.js
var require_errors = __commonJS({
  "../../node_modules/yaml/dist/errors.js"(exports2) {
    "use strict";
    var YAMLError = class extends Error {
      constructor(name, pos, code, message) {
        super();
        this.name = name;
        this.code = code;
        this.message = message;
        this.pos = pos;
      }
    };
    var YAMLParseError = class extends YAMLError {
      constructor(pos, code, message) {
        super("YAMLParseError", pos, code, message);
      }
    };
    var YAMLWarning = class extends YAMLError {
      constructor(pos, code, message) {
        super("YAMLWarning", pos, code, message);
      }
    };
    var prettifyError = (src, lc) => (error) => {
      if (error.pos[0] === -1)
        return;
      error.linePos = error.pos.map((pos) => lc.linePos(pos));
      const { line: line2, col } = error.linePos[0];
      error.message += ` at line ${line2}, column ${col}`;
      let ci2 = col - 1;
      let lineStr = src.substring(lc.lineStarts[line2 - 1], lc.lineStarts[line2]).replace(/[\n\r]+$/, "");
      if (ci2 >= 60 && lineStr.length > 80) {
        const trimStart = Math.min(ci2 - 39, lineStr.length - 79);
        lineStr = "\u2026" + lineStr.substring(trimStart);
        ci2 -= trimStart - 1;
      }
      if (lineStr.length > 80)
        lineStr = lineStr.substring(0, 79) + "\u2026";
      if (line2 > 1 && /^ *$/.test(lineStr.substring(0, ci2))) {
        let prev = src.substring(lc.lineStarts[line2 - 2], lc.lineStarts[line2 - 1]);
        if (prev.length > 80)
          prev = prev.substring(0, 79) + "\u2026\n";
        lineStr = prev + lineStr;
      }
      if (/[^ ]/.test(lineStr)) {
        let count = 1;
        const end = error.linePos[1];
        if (end?.line === line2 && end.col > col) {
          count = Math.max(1, Math.min(end.col - col, 80 - ci2));
        }
        const pointer = " ".repeat(ci2) + "^".repeat(count);
        error.message += `:

${lineStr}
${pointer}
`;
      }
    };
    exports2.YAMLError = YAMLError;
    exports2.YAMLParseError = YAMLParseError;
    exports2.YAMLWarning = YAMLWarning;
    exports2.prettifyError = prettifyError;
  }
});

// ../../node_modules/yaml/dist/compose/resolve-props.js
var require_resolve_props = __commonJS({
  "../../node_modules/yaml/dist/compose/resolve-props.js"(exports2) {
    "use strict";
    function resolveProps(tokens, { flow, indicator, next, offset, onError, parentIndent, startOnNewline }) {
      let spaceBefore = false;
      let atNewline = startOnNewline;
      let hasSpace = startOnNewline;
      let comment = "";
      let commentSep = "";
      let hasNewline = false;
      let reqSpace = false;
      let tab = null;
      let anchor = null;
      let tag = null;
      let newlineAfterProp = null;
      let comma = null;
      let found = null;
      let start = null;
      for (const token of tokens) {
        if (reqSpace) {
          if (token.type !== "space" && token.type !== "newline" && token.type !== "comma")
            onError(token.offset, "MISSING_CHAR", "Tags and anchors must be separated from the next token by white space");
          reqSpace = false;
        }
        if (tab) {
          if (atNewline && token.type !== "comment" && token.type !== "newline") {
            onError(tab, "TAB_AS_INDENT", "Tabs are not allowed as indentation");
          }
          tab = null;
        }
        switch (token.type) {
          case "space":
            if (!flow && (indicator !== "doc-start" || next?.type !== "flow-collection") && token.source.includes("	")) {
              tab = token;
            }
            hasSpace = true;
            break;
          case "comment": {
            if (!hasSpace)
              onError(token, "MISSING_CHAR", "Comments must be separated from other tokens by white space characters");
            const cb = token.source.substring(1) || " ";
            if (!comment)
              comment = cb;
            else
              comment += commentSep + cb;
            commentSep = "";
            atNewline = false;
            break;
          }
          case "newline":
            if (atNewline) {
              if (comment)
                comment += token.source;
              else if (!found || indicator !== "seq-item-ind")
                spaceBefore = true;
            } else
              commentSep += token.source;
            atNewline = true;
            hasNewline = true;
            if (anchor || tag)
              newlineAfterProp = token;
            hasSpace = true;
            break;
          case "anchor":
            if (anchor)
              onError(token, "MULTIPLE_ANCHORS", "A node can have at most one anchor");
            if (token.source.endsWith(":"))
              onError(token.offset + token.source.length - 1, "BAD_ALIAS", "Anchor ending in : is ambiguous", true);
            anchor = token;
            start ?? (start = token.offset);
            atNewline = false;
            hasSpace = false;
            reqSpace = true;
            break;
          case "tag": {
            if (tag)
              onError(token, "MULTIPLE_TAGS", "A node can have at most one tag");
            tag = token;
            start ?? (start = token.offset);
            atNewline = false;
            hasSpace = false;
            reqSpace = true;
            break;
          }
          case indicator:
            if (anchor || tag)
              onError(token, "BAD_PROP_ORDER", `Anchors and tags must be after the ${token.source} indicator`);
            if (found)
              onError(token, "UNEXPECTED_TOKEN", `Unexpected ${token.source} in ${flow ?? "collection"}`);
            found = token;
            atNewline = indicator === "seq-item-ind" || indicator === "explicit-key-ind";
            hasSpace = false;
            break;
          case "comma":
            if (flow) {
              if (comma)
                onError(token, "UNEXPECTED_TOKEN", `Unexpected , in ${flow}`);
              comma = token;
              atNewline = false;
              hasSpace = false;
              break;
            }
          // else fallthrough
          default:
            onError(token, "UNEXPECTED_TOKEN", `Unexpected ${token.type} token`);
            atNewline = false;
            hasSpace = false;
        }
      }
      const last = tokens[tokens.length - 1];
      const end = last ? last.offset + last.source.length : offset;
      if (reqSpace && next && next.type !== "space" && next.type !== "newline" && next.type !== "comma" && (next.type !== "scalar" || next.source !== "")) {
        onError(next.offset, "MISSING_CHAR", "Tags and anchors must be separated from the next token by white space");
      }
      if (tab && (atNewline && tab.indent <= parentIndent || next?.type === "block-map" || next?.type === "block-seq"))
        onError(tab, "TAB_AS_INDENT", "Tabs are not allowed as indentation");
      return {
        comma,
        found,
        spaceBefore,
        comment,
        hasNewline,
        anchor,
        tag,
        newlineAfterProp,
        end,
        start: start ?? end
      };
    }
    exports2.resolveProps = resolveProps;
  }
});

// ../../node_modules/yaml/dist/compose/util-contains-newline.js
var require_util_contains_newline = __commonJS({
  "../../node_modules/yaml/dist/compose/util-contains-newline.js"(exports2) {
    "use strict";
    function containsNewline(key) {
      if (!key)
        return null;
      switch (key.type) {
        case "alias":
        case "scalar":
        case "double-quoted-scalar":
        case "single-quoted-scalar":
          if (key.source.includes("\n"))
            return true;
          if (key.end) {
            for (const st of key.end)
              if (st.type === "newline")
                return true;
          }
          return false;
        case "flow-collection":
          for (const it of key.items) {
            for (const st of it.start)
              if (st.type === "newline")
                return true;
            if (it.sep) {
              for (const st of it.sep)
                if (st.type === "newline")
                  return true;
            }
            if (containsNewline(it.key) || containsNewline(it.value))
              return true;
          }
          return false;
        default:
          return true;
      }
    }
    exports2.containsNewline = containsNewline;
  }
});

// ../../node_modules/yaml/dist/compose/util-flow-indent-check.js
var require_util_flow_indent_check = __commonJS({
  "../../node_modules/yaml/dist/compose/util-flow-indent-check.js"(exports2) {
    "use strict";
    var utilContainsNewline = require_util_contains_newline();
    function flowIndentCheck(indent, fc, onError) {
      if (fc?.type === "flow-collection") {
        const end = fc.end[0];
        if (end.indent === indent && (end.source === "]" || end.source === "}") && utilContainsNewline.containsNewline(fc)) {
          const msg = "Flow end indicator should be more indented than parent";
          onError(end, "BAD_INDENT", msg, true);
        }
      }
    }
    exports2.flowIndentCheck = flowIndentCheck;
  }
});

// ../../node_modules/yaml/dist/compose/util-map-includes.js
var require_util_map_includes = __commonJS({
  "../../node_modules/yaml/dist/compose/util-map-includes.js"(exports2) {
    "use strict";
    var identity = require_identity();
    function mapIncludes(ctx, items2, search2) {
      const { uniqueKeys } = ctx.options;
      if (uniqueKeys === false)
        return false;
      const isEqual = typeof uniqueKeys === "function" ? uniqueKeys : (a, b) => a === b || identity.isScalar(a) && identity.isScalar(b) && a.value === b.value;
      return items2.some((pair) => isEqual(pair.key, search2));
    }
    exports2.mapIncludes = mapIncludes;
  }
});

// ../../node_modules/yaml/dist/compose/resolve-block-map.js
var require_resolve_block_map = __commonJS({
  "../../node_modules/yaml/dist/compose/resolve-block-map.js"(exports2) {
    "use strict";
    var Pair = require_Pair();
    var YAMLMap = require_YAMLMap();
    var resolveProps = require_resolve_props();
    var utilContainsNewline = require_util_contains_newline();
    var utilFlowIndentCheck = require_util_flow_indent_check();
    var utilMapIncludes = require_util_map_includes();
    var startColMsg = "All mapping items must start at the same column";
    function resolveBlockMap({ composeNode, composeEmptyNode }, ctx, bm, onError, tag) {
      const NodeClass = tag?.nodeClass ?? YAMLMap.YAMLMap;
      const map = new NodeClass(ctx.schema);
      if (ctx.atRoot)
        ctx.atRoot = false;
      let offset = bm.offset;
      let commentEnd = null;
      for (const collItem of bm.items) {
        const { start, key, sep, value } = collItem;
        const keyProps = resolveProps.resolveProps(start, {
          indicator: "explicit-key-ind",
          next: key ?? sep?.[0],
          offset,
          onError,
          parentIndent: bm.indent,
          startOnNewline: true
        });
        const implicitKey = !keyProps.found;
        if (implicitKey) {
          if (key) {
            if (key.type === "block-seq")
              onError(offset, "BLOCK_AS_IMPLICIT_KEY", "A block sequence may not be used as an implicit map key");
            else if ("indent" in key && key.indent !== bm.indent)
              onError(offset, "BAD_INDENT", startColMsg);
          }
          if (!keyProps.anchor && !keyProps.tag && !sep) {
            commentEnd = keyProps.end;
            if (keyProps.comment) {
              if (map.comment)
                map.comment += "\n" + keyProps.comment;
              else
                map.comment = keyProps.comment;
            }
            continue;
          }
          if (keyProps.newlineAfterProp || utilContainsNewline.containsNewline(key)) {
            onError(key ?? start[start.length - 1], "MULTILINE_IMPLICIT_KEY", "Implicit keys need to be on a single line");
          }
        } else if (keyProps.found?.indent !== bm.indent) {
          onError(offset, "BAD_INDENT", startColMsg);
        }
        ctx.atKey = true;
        const keyStart = keyProps.end;
        const keyNode = key ? composeNode(ctx, key, keyProps, onError) : composeEmptyNode(ctx, keyStart, start, null, keyProps, onError);
        if (ctx.schema.compat)
          utilFlowIndentCheck.flowIndentCheck(bm.indent, key, onError);
        ctx.atKey = false;
        if (utilMapIncludes.mapIncludes(ctx, map.items, keyNode))
          onError(keyStart, "DUPLICATE_KEY", "Map keys must be unique");
        const valueProps = resolveProps.resolveProps(sep ?? [], {
          indicator: "map-value-ind",
          next: value,
          offset: keyNode.range[2],
          onError,
          parentIndent: bm.indent,
          startOnNewline: !key || key.type === "block-scalar"
        });
        offset = valueProps.end;
        if (valueProps.found) {
          if (implicitKey) {
            if (value?.type === "block-map" && !valueProps.hasNewline)
              onError(offset, "BLOCK_AS_IMPLICIT_KEY", "Nested mappings are not allowed in compact mappings");
            if (ctx.options.strict && keyProps.start < valueProps.found.offset - 1024)
              onError(keyNode.range, "KEY_OVER_1024_CHARS", "The : indicator must be at most 1024 chars after the start of an implicit block mapping key");
          }
          const valueNode = value ? composeNode(ctx, value, valueProps, onError) : composeEmptyNode(ctx, offset, sep, null, valueProps, onError);
          if (ctx.schema.compat)
            utilFlowIndentCheck.flowIndentCheck(bm.indent, value, onError);
          offset = valueNode.range[2];
          const pair = new Pair.Pair(keyNode, valueNode);
          if (ctx.options.keepSourceTokens)
            pair.srcToken = collItem;
          map.items.push(pair);
        } else {
          if (implicitKey)
            onError(keyNode.range, "MISSING_CHAR", "Implicit map keys need to be followed by map values");
          if (valueProps.comment) {
            if (keyNode.comment)
              keyNode.comment += "\n" + valueProps.comment;
            else
              keyNode.comment = valueProps.comment;
          }
          const pair = new Pair.Pair(keyNode);
          if (ctx.options.keepSourceTokens)
            pair.srcToken = collItem;
          map.items.push(pair);
        }
      }
      if (commentEnd && commentEnd < offset)
        onError(commentEnd, "IMPOSSIBLE", "Map comment with trailing content");
      map.range = [bm.offset, offset, commentEnd ?? offset];
      return map;
    }
    exports2.resolveBlockMap = resolveBlockMap;
  }
});

// ../../node_modules/yaml/dist/compose/resolve-block-seq.js
var require_resolve_block_seq = __commonJS({
  "../../node_modules/yaml/dist/compose/resolve-block-seq.js"(exports2) {
    "use strict";
    var YAMLSeq = require_YAMLSeq();
    var resolveProps = require_resolve_props();
    var utilFlowIndentCheck = require_util_flow_indent_check();
    function resolveBlockSeq({ composeNode, composeEmptyNode }, ctx, bs, onError, tag) {
      const NodeClass = tag?.nodeClass ?? YAMLSeq.YAMLSeq;
      const seq = new NodeClass(ctx.schema);
      if (ctx.atRoot)
        ctx.atRoot = false;
      if (ctx.atKey)
        ctx.atKey = false;
      let offset = bs.offset;
      let commentEnd = null;
      for (const { start, value } of bs.items) {
        const props = resolveProps.resolveProps(start, {
          indicator: "seq-item-ind",
          next: value,
          offset,
          onError,
          parentIndent: bs.indent,
          startOnNewline: true
        });
        if (!props.found) {
          if (props.anchor || props.tag || value) {
            if (value?.type === "block-seq")
              onError(props.end, "BAD_INDENT", "All sequence items must start at the same column");
            else
              onError(offset, "MISSING_CHAR", "Sequence item without - indicator");
          } else {
            commentEnd = props.end;
            if (props.comment)
              seq.comment = props.comment;
            continue;
          }
        }
        const node = value ? composeNode(ctx, value, props, onError) : composeEmptyNode(ctx, props.end, start, null, props, onError);
        if (ctx.schema.compat)
          utilFlowIndentCheck.flowIndentCheck(bs.indent, value, onError);
        offset = node.range[2];
        seq.items.push(node);
      }
      seq.range = [bs.offset, offset, commentEnd ?? offset];
      return seq;
    }
    exports2.resolveBlockSeq = resolveBlockSeq;
  }
});

// ../../node_modules/yaml/dist/compose/resolve-end.js
var require_resolve_end = __commonJS({
  "../../node_modules/yaml/dist/compose/resolve-end.js"(exports2) {
    "use strict";
    function resolveEnd(end, offset, reqSpace, onError) {
      let comment = "";
      if (end) {
        let hasSpace = false;
        let sep = "";
        for (const token of end) {
          const { source, type } = token;
          switch (type) {
            case "space":
              hasSpace = true;
              break;
            case "comment": {
              if (reqSpace && !hasSpace)
                onError(token, "MISSING_CHAR", "Comments must be separated from other tokens by white space characters");
              const cb = source.substring(1) || " ";
              if (!comment)
                comment = cb;
              else
                comment += sep + cb;
              sep = "";
              break;
            }
            case "newline":
              if (comment)
                sep += source;
              hasSpace = true;
              break;
            default:
              onError(token, "UNEXPECTED_TOKEN", `Unexpected ${type} at node end`);
          }
          offset += source.length;
        }
      }
      return { comment, offset };
    }
    exports2.resolveEnd = resolveEnd;
  }
});

// ../../node_modules/yaml/dist/compose/resolve-flow-collection.js
var require_resolve_flow_collection = __commonJS({
  "../../node_modules/yaml/dist/compose/resolve-flow-collection.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var Pair = require_Pair();
    var YAMLMap = require_YAMLMap();
    var YAMLSeq = require_YAMLSeq();
    var resolveEnd = require_resolve_end();
    var resolveProps = require_resolve_props();
    var utilContainsNewline = require_util_contains_newline();
    var utilMapIncludes = require_util_map_includes();
    var blockMsg = "Block collections are not allowed within flow collections";
    var isBlock = (token) => token && (token.type === "block-map" || token.type === "block-seq");
    function resolveFlowCollection({ composeNode, composeEmptyNode }, ctx, fc, onError, tag) {
      const isMap5 = fc.start.source === "{";
      const fcName = isMap5 ? "flow map" : "flow sequence";
      const NodeClass = tag?.nodeClass ?? (isMap5 ? YAMLMap.YAMLMap : YAMLSeq.YAMLSeq);
      const coll = new NodeClass(ctx.schema);
      coll.flow = true;
      const atRoot = ctx.atRoot;
      if (atRoot)
        ctx.atRoot = false;
      if (ctx.atKey)
        ctx.atKey = false;
      let offset = fc.offset + fc.start.source.length;
      for (let i = 0; i < fc.items.length; ++i) {
        const collItem = fc.items[i];
        const { start, key, sep, value } = collItem;
        const props = resolveProps.resolveProps(start, {
          flow: fcName,
          indicator: "explicit-key-ind",
          next: key ?? sep?.[0],
          offset,
          onError,
          parentIndent: fc.indent,
          startOnNewline: false
        });
        if (!props.found) {
          if (!props.anchor && !props.tag && !sep && !value) {
            if (i === 0 && props.comma)
              onError(props.comma, "UNEXPECTED_TOKEN", `Unexpected , in ${fcName}`);
            else if (i < fc.items.length - 1)
              onError(props.start, "UNEXPECTED_TOKEN", `Unexpected empty item in ${fcName}`);
            if (props.comment) {
              if (coll.comment)
                coll.comment += "\n" + props.comment;
              else
                coll.comment = props.comment;
            }
            offset = props.end;
            continue;
          }
          if (!isMap5 && ctx.options.strict && utilContainsNewline.containsNewline(key))
            onError(
              key,
              // checked by containsNewline()
              "MULTILINE_IMPLICIT_KEY",
              "Implicit keys of flow sequence pairs need to be on a single line"
            );
        }
        if (i === 0) {
          if (props.comma)
            onError(props.comma, "UNEXPECTED_TOKEN", `Unexpected , in ${fcName}`);
        } else {
          if (!props.comma)
            onError(props.start, "MISSING_CHAR", `Missing , between ${fcName} items`);
          if (props.comment) {
            let prevItemComment = "";
            loop: for (const st of start) {
              switch (st.type) {
                case "comma":
                case "space":
                  break;
                case "comment":
                  prevItemComment = st.source.substring(1);
                  break loop;
                default:
                  break loop;
              }
            }
            if (prevItemComment) {
              let prev = coll.items[coll.items.length - 1];
              if (identity.isPair(prev))
                prev = prev.value ?? prev.key;
              if (prev.comment)
                prev.comment += "\n" + prevItemComment;
              else
                prev.comment = prevItemComment;
              props.comment = props.comment.substring(prevItemComment.length + 1);
            }
          }
        }
        if (!isMap5 && !sep && !props.found) {
          const valueNode = value ? composeNode(ctx, value, props, onError) : composeEmptyNode(ctx, props.end, sep, null, props, onError);
          coll.items.push(valueNode);
          offset = valueNode.range[2];
          if (isBlock(value))
            onError(valueNode.range, "BLOCK_IN_FLOW", blockMsg);
        } else {
          ctx.atKey = true;
          const keyStart = props.end;
          const keyNode = key ? composeNode(ctx, key, props, onError) : composeEmptyNode(ctx, keyStart, start, null, props, onError);
          if (isBlock(key))
            onError(keyNode.range, "BLOCK_IN_FLOW", blockMsg);
          ctx.atKey = false;
          const valueProps = resolveProps.resolveProps(sep ?? [], {
            flow: fcName,
            indicator: "map-value-ind",
            next: value,
            offset: keyNode.range[2],
            onError,
            parentIndent: fc.indent,
            startOnNewline: false
          });
          if (valueProps.found) {
            if (!isMap5 && !props.found && ctx.options.strict) {
              if (sep)
                for (const st of sep) {
                  if (st === valueProps.found)
                    break;
                  if (st.type === "newline") {
                    onError(st, "MULTILINE_IMPLICIT_KEY", "Implicit keys of flow sequence pairs need to be on a single line");
                    break;
                  }
                }
              if (props.start < valueProps.found.offset - 1024)
                onError(valueProps.found, "KEY_OVER_1024_CHARS", "The : indicator must be at most 1024 chars after the start of an implicit flow sequence key");
            }
          } else if (value) {
            if ("source" in value && value.source?.[0] === ":")
              onError(value, "MISSING_CHAR", `Missing space after : in ${fcName}`);
            else
              onError(valueProps.start, "MISSING_CHAR", `Missing , or : between ${fcName} items`);
          }
          const valueNode = value ? composeNode(ctx, value, valueProps, onError) : valueProps.found ? composeEmptyNode(ctx, valueProps.end, sep, null, valueProps, onError) : null;
          if (valueNode) {
            if (isBlock(value))
              onError(valueNode.range, "BLOCK_IN_FLOW", blockMsg);
          } else if (valueProps.comment) {
            if (keyNode.comment)
              keyNode.comment += "\n" + valueProps.comment;
            else
              keyNode.comment = valueProps.comment;
          }
          const pair = new Pair.Pair(keyNode, valueNode);
          if (ctx.options.keepSourceTokens)
            pair.srcToken = collItem;
          if (isMap5) {
            const map = coll;
            if (utilMapIncludes.mapIncludes(ctx, map.items, keyNode))
              onError(keyStart, "DUPLICATE_KEY", "Map keys must be unique");
            map.items.push(pair);
          } else {
            const map = new YAMLMap.YAMLMap(ctx.schema);
            map.flow = true;
            map.items.push(pair);
            const endRange = (valueNode ?? keyNode).range;
            map.range = [keyNode.range[0], endRange[1], endRange[2]];
            coll.items.push(map);
          }
          offset = valueNode ? valueNode.range[2] : valueProps.end;
        }
      }
      const expectedEnd = isMap5 ? "}" : "]";
      const [ce, ...ee] = fc.end;
      let cePos = offset;
      if (ce?.source === expectedEnd)
        cePos = ce.offset + ce.source.length;
      else {
        const name = fcName[0].toUpperCase() + fcName.substring(1);
        const msg = atRoot ? `${name} must end with a ${expectedEnd}` : `${name} in block collection must be sufficiently indented and end with a ${expectedEnd}`;
        onError(offset, atRoot ? "MISSING_CHAR" : "BAD_INDENT", msg);
        if (ce && ce.source.length !== 1)
          ee.unshift(ce);
      }
      if (ee.length > 0) {
        const end = resolveEnd.resolveEnd(ee, cePos, ctx.options.strict, onError);
        if (end.comment) {
          if (coll.comment)
            coll.comment += "\n" + end.comment;
          else
            coll.comment = end.comment;
        }
        coll.range = [fc.offset, cePos, end.offset];
      } else {
        coll.range = [fc.offset, cePos, cePos];
      }
      return coll;
    }
    exports2.resolveFlowCollection = resolveFlowCollection;
  }
});

// ../../node_modules/yaml/dist/compose/compose-collection.js
var require_compose_collection = __commonJS({
  "../../node_modules/yaml/dist/compose/compose-collection.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var Scalar2 = require_Scalar();
    var YAMLMap = require_YAMLMap();
    var YAMLSeq = require_YAMLSeq();
    var resolveBlockMap = require_resolve_block_map();
    var resolveBlockSeq = require_resolve_block_seq();
    var resolveFlowCollection = require_resolve_flow_collection();
    function resolveCollection(CN, ctx, token, onError, tagName, tag) {
      const coll = token.type === "block-map" ? resolveBlockMap.resolveBlockMap(CN, ctx, token, onError, tag) : token.type === "block-seq" ? resolveBlockSeq.resolveBlockSeq(CN, ctx, token, onError, tag) : resolveFlowCollection.resolveFlowCollection(CN, ctx, token, onError, tag);
      const Coll = coll.constructor;
      if (tagName === "!" || tagName === Coll.tagName) {
        coll.tag = Coll.tagName;
        return coll;
      }
      if (tagName)
        coll.tag = tagName;
      return coll;
    }
    function composeCollection(CN, ctx, token, props, onError) {
      const tagToken = props.tag;
      const tagName = !tagToken ? null : ctx.directives.tagName(tagToken.source, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg));
      if (token.type === "block-seq") {
        const { anchor, newlineAfterProp: nl } = props;
        const lastProp = anchor && tagToken ? anchor.offset > tagToken.offset ? anchor : tagToken : anchor ?? tagToken;
        if (lastProp && (!nl || nl.offset < lastProp.offset)) {
          const message = "Missing newline after block sequence props";
          onError(lastProp, "MISSING_CHAR", message);
        }
      }
      const expType = token.type === "block-map" ? "map" : token.type === "block-seq" ? "seq" : token.start.source === "{" ? "map" : "seq";
      if (!tagToken || !tagName || tagName === "!" || tagName === YAMLMap.YAMLMap.tagName && expType === "map" || tagName === YAMLSeq.YAMLSeq.tagName && expType === "seq") {
        return resolveCollection(CN, ctx, token, onError, tagName);
      }
      let tag = ctx.schema.tags.find((t) => t.tag === tagName && t.collection === expType);
      if (!tag) {
        const kt = ctx.schema.knownTags[tagName];
        if (kt?.collection === expType) {
          ctx.schema.tags.push(Object.assign({}, kt, { default: false }));
          tag = kt;
        } else {
          if (kt) {
            onError(tagToken, "BAD_COLLECTION_TYPE", `${kt.tag} used for ${expType} collection, but expects ${kt.collection ?? "scalar"}`, true);
          } else {
            onError(tagToken, "TAG_RESOLVE_FAILED", `Unresolved tag: ${tagName}`, true);
          }
          return resolveCollection(CN, ctx, token, onError, tagName);
        }
      }
      const coll = resolveCollection(CN, ctx, token, onError, tagName, tag);
      const res = tag.resolve?.(coll, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg), ctx.options) ?? coll;
      const node = identity.isNode(res) ? res : new Scalar2.Scalar(res);
      node.range = coll.range;
      node.tag = tagName;
      if (tag?.format)
        node.format = tag.format;
      return node;
    }
    exports2.composeCollection = composeCollection;
  }
});

// ../../node_modules/yaml/dist/compose/resolve-block-scalar.js
var require_resolve_block_scalar = __commonJS({
  "../../node_modules/yaml/dist/compose/resolve-block-scalar.js"(exports2) {
    "use strict";
    var Scalar2 = require_Scalar();
    function resolveBlockScalar(ctx, scalar, onError) {
      const start = scalar.offset;
      const header = parseBlockScalarHeader(scalar, ctx.options.strict, onError);
      if (!header)
        return { value: "", type: null, comment: "", range: [start, start, start] };
      const type = header.mode === ">" ? Scalar2.Scalar.BLOCK_FOLDED : Scalar2.Scalar.BLOCK_LITERAL;
      const lines = scalar.source ? splitLines(scalar.source) : [];
      let chompStart = lines.length;
      for (let i = lines.length - 1; i >= 0; --i) {
        const content = lines[i][1];
        if (content === "" || content === "\r")
          chompStart = i;
        else
          break;
      }
      if (chompStart === 0) {
        const value2 = header.chomp === "+" && lines.length > 0 ? "\n".repeat(Math.max(1, lines.length - 1)) : "";
        let end2 = start + header.length;
        if (scalar.source)
          end2 += scalar.source.length;
        return { value: value2, type, comment: header.comment, range: [start, end2, end2] };
      }
      let trimIndent = scalar.indent + header.indent;
      let offset = scalar.offset + header.length;
      let contentStart = 0;
      for (let i = 0; i < chompStart; ++i) {
        const [indent, content] = lines[i];
        if (content === "" || content === "\r") {
          if (header.indent === 0 && indent.length > trimIndent)
            trimIndent = indent.length;
        } else {
          if (indent.length < trimIndent) {
            const message = "Block scalars with more-indented leading empty lines must use an explicit indentation indicator";
            onError(offset + indent.length, "MISSING_CHAR", message);
          }
          if (header.indent === 0)
            trimIndent = indent.length;
          contentStart = i;
          if (trimIndent === 0 && !ctx.atRoot) {
            const message = "Block scalar values in collections must be indented";
            onError(offset, "BAD_INDENT", message);
          }
          break;
        }
        offset += indent.length + content.length + 1;
      }
      for (let i = lines.length - 1; i >= chompStart; --i) {
        if (lines[i][0].length > trimIndent)
          chompStart = i + 1;
      }
      let value = "";
      let sep = "";
      let prevMoreIndented = false;
      for (let i = 0; i < contentStart; ++i)
        value += lines[i][0].slice(trimIndent) + "\n";
      for (let i = contentStart; i < chompStart; ++i) {
        let [indent, content] = lines[i];
        offset += indent.length + content.length + 1;
        const crlf = content[content.length - 1] === "\r";
        if (crlf)
          content = content.slice(0, -1);
        if (content && indent.length < trimIndent) {
          const src = header.indent ? "explicit indentation indicator" : "first line";
          const message = `Block scalar lines must not be less indented than their ${src}`;
          onError(offset - content.length - (crlf ? 2 : 1), "BAD_INDENT", message);
          indent = "";
        }
        if (type === Scalar2.Scalar.BLOCK_LITERAL) {
          value += sep + indent.slice(trimIndent) + content;
          sep = "\n";
        } else if (indent.length > trimIndent || content[0] === "	") {
          if (sep === " ")
            sep = "\n";
          else if (!prevMoreIndented && sep === "\n")
            sep = "\n\n";
          value += sep + indent.slice(trimIndent) + content;
          sep = "\n";
          prevMoreIndented = true;
        } else if (content === "") {
          if (sep === "\n")
            value += "\n";
          else
            sep = "\n";
        } else {
          value += sep + content;
          sep = " ";
          prevMoreIndented = false;
        }
      }
      switch (header.chomp) {
        case "-":
          break;
        case "+":
          for (let i = chompStart; i < lines.length; ++i)
            value += "\n" + lines[i][0].slice(trimIndent);
          if (value[value.length - 1] !== "\n")
            value += "\n";
          break;
        default:
          value += "\n";
      }
      const end = start + header.length + scalar.source.length;
      return { value, type, comment: header.comment, range: [start, end, end] };
    }
    function parseBlockScalarHeader({ offset, props }, strict, onError) {
      if (props[0].type !== "block-scalar-header") {
        onError(props[0], "IMPOSSIBLE", "Block scalar header not found");
        return null;
      }
      const { source } = props[0];
      const mode = source[0];
      let indent = 0;
      let chomp = "";
      let error = -1;
      for (let i = 1; i < source.length; ++i) {
        const ch = source[i];
        if (!chomp && (ch === "-" || ch === "+"))
          chomp = ch;
        else {
          const n = Number(ch);
          if (!indent && n)
            indent = n;
          else if (error === -1)
            error = offset + i;
        }
      }
      if (error !== -1)
        onError(error, "UNEXPECTED_TOKEN", `Block scalar header includes extra characters: ${source}`);
      let hasSpace = false;
      let comment = "";
      let length = source.length;
      for (let i = 1; i < props.length; ++i) {
        const token = props[i];
        switch (token.type) {
          case "space":
            hasSpace = true;
          // fallthrough
          case "newline":
            length += token.source.length;
            break;
          case "comment":
            if (strict && !hasSpace) {
              const message = "Comments must be separated from other tokens by white space characters";
              onError(token, "MISSING_CHAR", message);
            }
            length += token.source.length;
            comment = token.source.substring(1);
            break;
          case "error":
            onError(token, "UNEXPECTED_TOKEN", token.message);
            length += token.source.length;
            break;
          /* istanbul ignore next should not happen */
          default: {
            const message = `Unexpected token in block scalar header: ${token.type}`;
            onError(token, "UNEXPECTED_TOKEN", message);
            const ts = token.source;
            if (ts && typeof ts === "string")
              length += ts.length;
          }
        }
      }
      return { mode, indent, chomp, comment, length };
    }
    function splitLines(source) {
      const split = source.split(/\n( *)/);
      const first = split[0];
      const m = first.match(/^( *)/);
      const line0 = m?.[1] ? [m[1], first.slice(m[1].length)] : ["", first];
      const lines = [line0];
      for (let i = 1; i < split.length; i += 2)
        lines.push([split[i], split[i + 1]]);
      return lines;
    }
    exports2.resolveBlockScalar = resolveBlockScalar;
  }
});

// ../../node_modules/yaml/dist/compose/resolve-flow-scalar.js
var require_resolve_flow_scalar = __commonJS({
  "../../node_modules/yaml/dist/compose/resolve-flow-scalar.js"(exports2) {
    "use strict";
    var Scalar2 = require_Scalar();
    var resolveEnd = require_resolve_end();
    function resolveFlowScalar(scalar, strict, onError) {
      const { offset, type, source, end } = scalar;
      let _type;
      let value;
      const _onError = (rel, code, msg) => onError(offset + rel, code, msg);
      switch (type) {
        case "scalar":
          _type = Scalar2.Scalar.PLAIN;
          value = plainValue(source, _onError);
          break;
        case "single-quoted-scalar":
          _type = Scalar2.Scalar.QUOTE_SINGLE;
          value = singleQuotedValue(source, _onError);
          break;
        case "double-quoted-scalar":
          _type = Scalar2.Scalar.QUOTE_DOUBLE;
          value = doubleQuotedValue(source, _onError);
          break;
        /* istanbul ignore next should not happen */
        default:
          onError(scalar, "UNEXPECTED_TOKEN", `Expected a flow scalar value, but found: ${type}`);
          return {
            value: "",
            type: null,
            comment: "",
            range: [offset, offset + source.length, offset + source.length]
          };
      }
      const valueEnd = offset + source.length;
      const re = resolveEnd.resolveEnd(end, valueEnd, strict, onError);
      return {
        value,
        type: _type,
        comment: re.comment,
        range: [offset, valueEnd, re.offset]
      };
    }
    function plainValue(source, onError) {
      let badChar = "";
      switch (source[0]) {
        /* istanbul ignore next should not happen */
        case "	":
          badChar = "a tab character";
          break;
        case ",":
          badChar = "flow indicator character ,";
          break;
        case "%":
          badChar = "directive indicator character %";
          break;
        case "|":
        case ">": {
          badChar = `block scalar indicator ${source[0]}`;
          break;
        }
        case "@":
        case "`": {
          badChar = `reserved character ${source[0]}`;
          break;
        }
      }
      if (badChar)
        onError(0, "BAD_SCALAR_START", `Plain value cannot start with ${badChar}`);
      return unfoldLines(source);
    }
    function singleQuotedValue(source, onError) {
      if (source[source.length - 1] !== "'" || source.length === 1)
        onError(source.length, "MISSING_CHAR", "Missing closing 'quote");
      return unfoldLines(source.slice(1, -1)).replace(/''/g, "'");
    }
    function unfoldLines(source) {
      const line2 = /(.*?)\r?\n/sy;
      let match = line2.exec(source);
      if (!match)
        return source;
      let trimEnd, trimBoth;
      try {
        trimEnd = new RegExp("(?<![ 	])[ 	]+$");
        trimBoth = new RegExp("^[ 	]+|(?<![ 	])[ 	]+$", "g");
      } catch {
        trimEnd = /[ \t]+$/;
        trimBoth = /^[ \t]+|[ \t]+$/g;
      }
      let res = match[1].replace(trimEnd, "");
      let sep = " ";
      let pos = line2.lastIndex;
      while (match = line2.exec(source)) {
        const lm = match[1].replace(trimBoth, "");
        if (lm === "") {
          if (sep === "\n")
            res += sep;
          else
            sep = "\n";
        } else {
          res += sep + lm;
          sep = " ";
        }
        pos = line2.lastIndex;
      }
      const last = /[ \t]*(.*)/sy;
      last.lastIndex = pos;
      match = last.exec(source);
      return res + sep + (match?.[1] ?? "");
    }
    function doubleQuotedValue(source, onError) {
      let res = "";
      for (let i = 1; i < source.length - 1; ++i) {
        const ch = source[i];
        if (ch === "\r" && source[i + 1] === "\n")
          continue;
        if (ch === "\n") {
          const { fold, offset } = foldNewline(source, i);
          res += fold;
          i = offset;
        } else if (ch === "\\") {
          let next = source[++i];
          const cc = escapeCodes[next];
          if (cc)
            res += cc;
          else if (next === "\n") {
            next = source[i + 1];
            while (next === " " || next === "	")
              next = source[++i + 1];
          } else if (next === "\r" && source[i + 1] === "\n") {
            next = source[++i + 1];
            while (next === " " || next === "	")
              next = source[++i + 1];
          } else if (next === "x" || next === "u" || next === "U") {
            const length = next === "x" ? 2 : next === "u" ? 4 : 8;
            res += parseCharCode(source, i + 1, length, onError);
            i += length;
          } else {
            const raw = source.substr(i - 1, 2);
            onError(i - 1, "BAD_DQ_ESCAPE", `Invalid escape sequence ${raw}`);
            res += raw;
          }
        } else if (ch === " " || ch === "	") {
          const wsStart = i;
          let next = source[i + 1];
          while (next === " " || next === "	")
            next = source[++i + 1];
          if (next !== "\n" && !(next === "\r" && source[i + 2] === "\n"))
            res += i > wsStart ? source.slice(wsStart, i + 1) : ch;
        } else {
          res += ch;
        }
      }
      if (source[source.length - 1] !== '"' || source.length === 1)
        onError(source.length, "MISSING_CHAR", 'Missing closing "quote');
      return res;
    }
    function foldNewline(source, offset) {
      let fold = "";
      let ch = source[offset + 1];
      while (ch === " " || ch === "	" || ch === "\n" || ch === "\r") {
        if (ch === "\r" && source[offset + 2] !== "\n")
          break;
        if (ch === "\n")
          fold += "\n";
        offset += 1;
        ch = source[offset + 1];
      }
      if (!fold)
        fold = " ";
      return { fold, offset };
    }
    var escapeCodes = {
      "0": "\0",
      // null character
      a: "\x07",
      // bell character
      b: "\b",
      // backspace
      e: "\x1B",
      // escape character
      f: "\f",
      // form feed
      n: "\n",
      // line feed
      r: "\r",
      // carriage return
      t: "	",
      // horizontal tab
      v: "\v",
      // vertical tab
      N: "\x85",
      // Unicode next line
      _: "\xA0",
      // Unicode non-breaking space
      L: "\u2028",
      // Unicode line separator
      P: "\u2029",
      // Unicode paragraph separator
      " ": " ",
      '"': '"',
      "/": "/",
      "\\": "\\",
      "	": "	"
    };
    function parseCharCode(source, offset, length, onError) {
      const cc = source.substr(offset, length);
      const ok = cc.length === length && /^[0-9a-fA-F]+$/.test(cc);
      const code = ok ? parseInt(cc, 16) : NaN;
      try {
        return String.fromCodePoint(code);
      } catch {
        const raw = source.substr(offset - 2, length + 2);
        onError(offset - 2, "BAD_DQ_ESCAPE", `Invalid escape sequence ${raw}`);
        return raw;
      }
    }
    exports2.resolveFlowScalar = resolveFlowScalar;
  }
});

// ../../node_modules/yaml/dist/compose/compose-scalar.js
var require_compose_scalar = __commonJS({
  "../../node_modules/yaml/dist/compose/compose-scalar.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var Scalar2 = require_Scalar();
    var resolveBlockScalar = require_resolve_block_scalar();
    var resolveFlowScalar = require_resolve_flow_scalar();
    function composeScalar(ctx, token, tagToken, onError) {
      const { value, type, comment, range } = token.type === "block-scalar" ? resolveBlockScalar.resolveBlockScalar(ctx, token, onError) : resolveFlowScalar.resolveFlowScalar(token, ctx.options.strict, onError);
      const tagName = tagToken ? ctx.directives.tagName(tagToken.source, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg)) : null;
      let tag;
      if (ctx.options.stringKeys && ctx.atKey) {
        tag = ctx.schema[identity.SCALAR];
      } else if (tagName)
        tag = findScalarTagByName(ctx.schema, value, tagName, tagToken, onError);
      else if (token.type === "scalar")
        tag = findScalarTagByTest(ctx, value, token, onError);
      else
        tag = ctx.schema[identity.SCALAR];
      let scalar;
      try {
        const res = tag.resolve(value, (msg) => onError(tagToken ?? token, "TAG_RESOLVE_FAILED", msg), ctx.options);
        scalar = identity.isScalar(res) ? res : new Scalar2.Scalar(res);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        onError(tagToken ?? token, "TAG_RESOLVE_FAILED", msg);
        scalar = new Scalar2.Scalar(value);
      }
      scalar.range = range;
      scalar.source = value;
      if (type)
        scalar.type = type;
      if (tagName)
        scalar.tag = tagName;
      if (tag.format)
        scalar.format = tag.format;
      if (comment)
        scalar.comment = comment;
      return scalar;
    }
    function findScalarTagByName(schema, value, tagName, tagToken, onError) {
      if (tagName === "!")
        return schema[identity.SCALAR];
      const matchWithTest = [];
      for (const tag of schema.tags) {
        if (!tag.collection && tag.tag === tagName) {
          if (tag.default && tag.test)
            matchWithTest.push(tag);
          else
            return tag;
        }
      }
      for (const tag of matchWithTest)
        if (tag.test?.test(value))
          return tag;
      const kt = schema.knownTags[tagName];
      if (kt && !kt.collection) {
        schema.tags.push(Object.assign({}, kt, { default: false, test: void 0 }));
        return kt;
      }
      onError(tagToken, "TAG_RESOLVE_FAILED", `Unresolved tag: ${tagName}`, tagName !== "tag:yaml.org,2002:str");
      return schema[identity.SCALAR];
    }
    function findScalarTagByTest({ atKey, directives, schema }, value, token, onError) {
      const tag = schema.tags.find((tag2) => (tag2.default === true || atKey && tag2.default === "key") && tag2.test?.test(value)) || schema[identity.SCALAR];
      if (schema.compat) {
        const compat = schema.compat.find((tag2) => tag2.default && tag2.test?.test(value)) ?? schema[identity.SCALAR];
        if (tag.tag !== compat.tag) {
          const ts = directives.tagString(tag.tag);
          const cs = directives.tagString(compat.tag);
          const msg = `Value may be parsed as either ${ts} or ${cs}`;
          onError(token, "TAG_RESOLVE_FAILED", msg, true);
        }
      }
      return tag;
    }
    exports2.composeScalar = composeScalar;
  }
});

// ../../node_modules/yaml/dist/compose/util-empty-scalar-position.js
var require_util_empty_scalar_position = __commonJS({
  "../../node_modules/yaml/dist/compose/util-empty-scalar-position.js"(exports2) {
    "use strict";
    function emptyScalarPosition(offset, before, pos) {
      if (before) {
        pos ?? (pos = before.length);
        for (let i = pos - 1; i >= 0; --i) {
          let st = before[i];
          switch (st.type) {
            case "space":
            case "comment":
            case "newline":
              offset -= st.source.length;
              continue;
          }
          st = before[++i];
          while (st?.type === "space") {
            offset += st.source.length;
            st = before[++i];
          }
          break;
        }
      }
      return offset;
    }
    exports2.emptyScalarPosition = emptyScalarPosition;
  }
});

// ../../node_modules/yaml/dist/compose/compose-node.js
var require_compose_node = __commonJS({
  "../../node_modules/yaml/dist/compose/compose-node.js"(exports2) {
    "use strict";
    var Alias = require_Alias();
    var identity = require_identity();
    var composeCollection = require_compose_collection();
    var composeScalar = require_compose_scalar();
    var resolveEnd = require_resolve_end();
    var utilEmptyScalarPosition = require_util_empty_scalar_position();
    var CN = { composeNode, composeEmptyNode };
    function composeNode(ctx, token, props, onError) {
      const atKey = ctx.atKey;
      const { spaceBefore, comment, anchor, tag } = props;
      let node;
      let isSrcToken = true;
      switch (token.type) {
        case "alias":
          node = composeAlias(ctx, token, onError);
          if (anchor || tag)
            onError(token, "ALIAS_PROPS", "An alias node must not specify any properties");
          break;
        case "scalar":
        case "single-quoted-scalar":
        case "double-quoted-scalar":
        case "block-scalar":
          node = composeScalar.composeScalar(ctx, token, tag, onError);
          if (anchor)
            node.anchor = anchor.source.substring(1);
          break;
        case "block-map":
        case "block-seq":
        case "flow-collection":
          try {
            node = composeCollection.composeCollection(CN, ctx, token, props, onError);
            if (anchor)
              node.anchor = anchor.source.substring(1);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            onError(token, "RESOURCE_EXHAUSTION", message);
          }
          break;
        default: {
          const message = token.type === "error" ? token.message : `Unsupported token (type: ${token.type})`;
          onError(token, "UNEXPECTED_TOKEN", message);
          isSrcToken = false;
        }
      }
      node ?? (node = composeEmptyNode(ctx, token.offset, void 0, null, props, onError));
      if (anchor && node.anchor === "")
        onError(anchor, "BAD_ALIAS", "Anchor cannot be an empty string");
      if (atKey && ctx.options.stringKeys && (!identity.isScalar(node) || typeof node.value !== "string" || node.tag && node.tag !== "tag:yaml.org,2002:str")) {
        const msg = "With stringKeys, all keys must be strings";
        onError(tag ?? token, "NON_STRING_KEY", msg);
      }
      if (spaceBefore)
        node.spaceBefore = true;
      if (comment) {
        if (token.type === "scalar" && token.source === "")
          node.comment = comment;
        else
          node.commentBefore = comment;
      }
      if (ctx.options.keepSourceTokens && isSrcToken)
        node.srcToken = token;
      return node;
    }
    function composeEmptyNode(ctx, offset, before, pos, { spaceBefore, comment, anchor, tag, end }, onError) {
      const token = {
        type: "scalar",
        offset: utilEmptyScalarPosition.emptyScalarPosition(offset, before, pos),
        indent: -1,
        source: ""
      };
      const node = composeScalar.composeScalar(ctx, token, tag, onError);
      if (anchor) {
        node.anchor = anchor.source.substring(1);
        if (node.anchor === "")
          onError(anchor, "BAD_ALIAS", "Anchor cannot be an empty string");
      }
      if (spaceBefore)
        node.spaceBefore = true;
      if (comment) {
        node.comment = comment;
        node.range[2] = end;
      }
      return node;
    }
    function composeAlias({ options }, { offset, source, end }, onError) {
      const alias = new Alias.Alias(source.substring(1));
      if (alias.source === "")
        onError(offset, "BAD_ALIAS", "Alias cannot be an empty string");
      if (alias.source.endsWith(":"))
        onError(offset + source.length - 1, "BAD_ALIAS", "Alias ending in : is ambiguous", true);
      const valueEnd = offset + source.length;
      const re = resolveEnd.resolveEnd(end, valueEnd, options.strict, onError);
      alias.range = [offset, valueEnd, re.offset];
      if (re.comment)
        alias.comment = re.comment;
      return alias;
    }
    exports2.composeEmptyNode = composeEmptyNode;
    exports2.composeNode = composeNode;
  }
});

// ../../node_modules/yaml/dist/compose/compose-doc.js
var require_compose_doc = __commonJS({
  "../../node_modules/yaml/dist/compose/compose-doc.js"(exports2) {
    "use strict";
    var Document = require_Document();
    var composeNode = require_compose_node();
    var resolveEnd = require_resolve_end();
    var resolveProps = require_resolve_props();
    function composeDoc(options, directives, { offset, start, value, end }, onError) {
      const opts = Object.assign({ _directives: directives }, options);
      const doc = new Document.Document(void 0, opts);
      const ctx = {
        atKey: false,
        atRoot: true,
        directives: doc.directives,
        options: doc.options,
        schema: doc.schema
      };
      const props = resolveProps.resolveProps(start, {
        indicator: "doc-start",
        next: value ?? end?.[0],
        offset,
        onError,
        parentIndent: 0,
        startOnNewline: true
      });
      if (props.found) {
        doc.directives.docStart = true;
        if (value && (value.type === "block-map" || value.type === "block-seq") && !props.hasNewline)
          onError(props.end, "MISSING_CHAR", "Block collection cannot start on same line with directives-end marker");
      }
      doc.contents = value ? composeNode.composeNode(ctx, value, props, onError) : composeNode.composeEmptyNode(ctx, props.end, start, null, props, onError);
      const contentEnd = doc.contents.range[2];
      const re = resolveEnd.resolveEnd(end, contentEnd, false, onError);
      if (re.comment)
        doc.comment = re.comment;
      doc.range = [offset, contentEnd, re.offset];
      return doc;
    }
    exports2.composeDoc = composeDoc;
  }
});

// ../../node_modules/yaml/dist/compose/composer.js
var require_composer = __commonJS({
  "../../node_modules/yaml/dist/compose/composer.js"(exports2) {
    "use strict";
    var node_process = require("process");
    var directives = require_directives();
    var Document = require_Document();
    var errors = require_errors();
    var identity = require_identity();
    var composeDoc = require_compose_doc();
    var resolveEnd = require_resolve_end();
    function getErrorPos(src) {
      if (typeof src === "number")
        return [src, src + 1];
      if (Array.isArray(src))
        return src.length === 2 ? src : [src[0], src[1]];
      const { offset, source } = src;
      return [offset, offset + (typeof source === "string" ? source.length : 1)];
    }
    function parsePrelude(prelude) {
      let comment = "";
      let atComment = false;
      let afterEmptyLine = false;
      for (let i = 0; i < prelude.length; ++i) {
        const source = prelude[i];
        switch (source[0]) {
          case "#":
            comment += (comment === "" ? "" : afterEmptyLine ? "\n\n" : "\n") + (source.substring(1) || " ");
            atComment = true;
            afterEmptyLine = false;
            break;
          case "%":
            if (prelude[i + 1]?.[0] !== "#")
              i += 1;
            atComment = false;
            break;
          default:
            if (!atComment)
              afterEmptyLine = true;
            atComment = false;
        }
      }
      return { comment, afterEmptyLine };
    }
    var Composer = class {
      constructor(options = {}) {
        this.doc = null;
        this.atDirectives = false;
        this.prelude = [];
        this.errors = [];
        this.warnings = [];
        this.onError = (source, code, message, warning) => {
          const pos = getErrorPos(source);
          if (warning)
            this.warnings.push(new errors.YAMLWarning(pos, code, message));
          else
            this.errors.push(new errors.YAMLParseError(pos, code, message));
        };
        this.directives = new directives.Directives({ version: options.version || "1.2" });
        this.options = options;
      }
      decorate(doc, afterDoc) {
        const { comment, afterEmptyLine } = parsePrelude(this.prelude);
        if (comment) {
          const dc = doc.contents;
          if (afterDoc) {
            doc.comment = doc.comment ? `${doc.comment}
${comment}` : comment;
          } else if (afterEmptyLine || doc.directives.docStart || !dc) {
            doc.commentBefore = comment;
          } else if (identity.isCollection(dc) && !dc.flow && dc.items.length > 0) {
            let it = dc.items[0];
            if (identity.isPair(it))
              it = it.key;
            const cb = it.commentBefore;
            it.commentBefore = cb ? `${comment}
${cb}` : comment;
          } else {
            const cb = dc.commentBefore;
            dc.commentBefore = cb ? `${comment}
${cb}` : comment;
          }
        }
        if (afterDoc) {
          for (let i = 0; i < this.errors.length; ++i)
            doc.errors.push(this.errors[i]);
          for (let i = 0; i < this.warnings.length; ++i)
            doc.warnings.push(this.warnings[i]);
        } else {
          doc.errors = this.errors;
          doc.warnings = this.warnings;
        }
        this.prelude = [];
        this.errors = [];
        this.warnings = [];
      }
      /**
       * Current stream status information.
       *
       * Mostly useful at the end of input for an empty stream.
       */
      streamInfo() {
        return {
          comment: parsePrelude(this.prelude).comment,
          directives: this.directives,
          errors: this.errors,
          warnings: this.warnings
        };
      }
      /**
       * Compose tokens into documents.
       *
       * @param forceDoc - If the stream contains no document, still emit a final document including any comments and directives that would be applied to a subsequent document.
       * @param endOffset - Should be set if `forceDoc` is also set, to set the document range end and to indicate errors correctly.
       */
      *compose(tokens, forceDoc = false, endOffset = -1) {
        for (const token of tokens)
          yield* this.next(token);
        yield* this.end(forceDoc, endOffset);
      }
      /** Advance the composer by one CST token. */
      *next(token) {
        if (node_process.env.LOG_STREAM)
          console.dir(token, { depth: null });
        switch (token.type) {
          case "directive":
            this.directives.add(token.source, (offset, message, warning) => {
              const pos = getErrorPos(token);
              pos[0] += offset;
              this.onError(pos, "BAD_DIRECTIVE", message, warning);
            });
            this.prelude.push(token.source);
            this.atDirectives = true;
            break;
          case "document": {
            const doc = composeDoc.composeDoc(this.options, this.directives, token, this.onError);
            if (this.atDirectives && !doc.directives.docStart)
              this.onError(token, "MISSING_CHAR", "Missing directives-end/doc-start indicator line");
            this.decorate(doc, false);
            if (this.doc)
              yield this.doc;
            this.doc = doc;
            this.atDirectives = false;
            break;
          }
          case "byte-order-mark":
          case "space":
            break;
          case "comment":
          case "newline":
            this.prelude.push(token.source);
            break;
          case "error": {
            const msg = token.source ? `${token.message}: ${JSON.stringify(token.source)}` : token.message;
            const error = new errors.YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", msg);
            if (this.atDirectives || !this.doc)
              this.errors.push(error);
            else
              this.doc.errors.push(error);
            break;
          }
          case "doc-end": {
            if (!this.doc) {
              const msg = "Unexpected doc-end without preceding document";
              this.errors.push(new errors.YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", msg));
              break;
            }
            this.doc.directives.docEnd = true;
            const end = resolveEnd.resolveEnd(token.end, token.offset + token.source.length, this.doc.options.strict, this.onError);
            this.decorate(this.doc, true);
            if (end.comment) {
              const dc = this.doc.comment;
              this.doc.comment = dc ? `${dc}
${end.comment}` : end.comment;
            }
            this.doc.range[2] = end.offset;
            break;
          }
          default:
            this.errors.push(new errors.YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", `Unsupported token ${token.type}`));
        }
      }
      /**
       * Call at end of input to yield any remaining document.
       *
       * @param forceDoc - If the stream contains no document, still emit a final document including any comments and directives that would be applied to a subsequent document.
       * @param endOffset - Should be set if `forceDoc` is also set, to set the document range end and to indicate errors correctly.
       */
      *end(forceDoc = false, endOffset = -1) {
        if (this.doc) {
          this.decorate(this.doc, true);
          yield this.doc;
          this.doc = null;
        } else if (forceDoc) {
          const opts = Object.assign({ _directives: this.directives }, this.options);
          const doc = new Document.Document(void 0, opts);
          if (this.atDirectives)
            this.onError(endOffset, "MISSING_CHAR", "Missing directives-end indicator line");
          doc.range = [0, endOffset, endOffset];
          this.decorate(doc, false);
          yield doc;
        }
      }
    };
    exports2.Composer = Composer;
  }
});

// ../../node_modules/yaml/dist/parse/cst-scalar.js
var require_cst_scalar = __commonJS({
  "../../node_modules/yaml/dist/parse/cst-scalar.js"(exports2) {
    "use strict";
    var resolveBlockScalar = require_resolve_block_scalar();
    var resolveFlowScalar = require_resolve_flow_scalar();
    var errors = require_errors();
    var stringifyString = require_stringifyString();
    function resolveAsScalar(token, strict = true, onError) {
      if (token) {
        const _onError = (pos, code, message) => {
          const offset = typeof pos === "number" ? pos : Array.isArray(pos) ? pos[0] : pos.offset;
          if (onError)
            onError(offset, code, message);
          else
            throw new errors.YAMLParseError([offset, offset + 1], code, message);
        };
        switch (token.type) {
          case "scalar":
          case "single-quoted-scalar":
          case "double-quoted-scalar":
            return resolveFlowScalar.resolveFlowScalar(token, strict, _onError);
          case "block-scalar":
            return resolveBlockScalar.resolveBlockScalar({ options: { strict } }, token, _onError);
        }
      }
      return null;
    }
    function createScalarToken(value, context) {
      const { implicitKey = false, indent, inFlow = false, offset = -1, type = "PLAIN" } = context;
      const source = stringifyString.stringifyString({ type, value }, {
        implicitKey,
        indent: indent > 0 ? " ".repeat(indent) : "",
        inFlow,
        options: { blockQuote: true, lineWidth: -1 }
      });
      const end = context.end ?? [
        { type: "newline", offset: -1, indent, source: "\n" }
      ];
      switch (source[0]) {
        case "|":
        case ">": {
          const he = source.indexOf("\n");
          const head = source.substring(0, he);
          const body = source.substring(he + 1) + "\n";
          const props = [
            { type: "block-scalar-header", offset, indent, source: head }
          ];
          if (!addEndtoBlockProps(props, end))
            props.push({ type: "newline", offset: -1, indent, source: "\n" });
          return { type: "block-scalar", offset, indent, props, source: body };
        }
        case '"':
          return { type: "double-quoted-scalar", offset, indent, source, end };
        case "'":
          return { type: "single-quoted-scalar", offset, indent, source, end };
        default:
          return { type: "scalar", offset, indent, source, end };
      }
    }
    function setScalarValue(token, value, context = {}) {
      let { afterKey = false, implicitKey = false, inFlow = false, type } = context;
      let indent = "indent" in token ? token.indent : null;
      if (afterKey && typeof indent === "number")
        indent += 2;
      if (!type)
        switch (token.type) {
          case "single-quoted-scalar":
            type = "QUOTE_SINGLE";
            break;
          case "double-quoted-scalar":
            type = "QUOTE_DOUBLE";
            break;
          case "block-scalar": {
            const header = token.props[0];
            if (header.type !== "block-scalar-header")
              throw new Error("Invalid block scalar header");
            type = header.source[0] === ">" ? "BLOCK_FOLDED" : "BLOCK_LITERAL";
            break;
          }
          default:
            type = "PLAIN";
        }
      const source = stringifyString.stringifyString({ type, value }, {
        implicitKey: implicitKey || indent === null,
        indent: indent !== null && indent > 0 ? " ".repeat(indent) : "",
        inFlow,
        options: { blockQuote: true, lineWidth: -1 }
      });
      switch (source[0]) {
        case "|":
        case ">":
          setBlockScalarValue(token, source);
          break;
        case '"':
          setFlowScalarValue(token, source, "double-quoted-scalar");
          break;
        case "'":
          setFlowScalarValue(token, source, "single-quoted-scalar");
          break;
        default:
          setFlowScalarValue(token, source, "scalar");
      }
    }
    function setBlockScalarValue(token, source) {
      const he = source.indexOf("\n");
      const head = source.substring(0, he);
      const body = source.substring(he + 1) + "\n";
      if (token.type === "block-scalar") {
        const header = token.props[0];
        if (header.type !== "block-scalar-header")
          throw new Error("Invalid block scalar header");
        header.source = head;
        token.source = body;
      } else {
        const { offset } = token;
        const indent = "indent" in token ? token.indent : -1;
        const props = [
          { type: "block-scalar-header", offset, indent, source: head }
        ];
        if (!addEndtoBlockProps(props, "end" in token ? token.end : void 0))
          props.push({ type: "newline", offset: -1, indent, source: "\n" });
        for (const key of Object.keys(token))
          if (key !== "type" && key !== "offset")
            delete token[key];
        Object.assign(token, { type: "block-scalar", indent, props, source: body });
      }
    }
    function addEndtoBlockProps(props, end) {
      if (end)
        for (const st of end)
          switch (st.type) {
            case "space":
            case "comment":
              props.push(st);
              break;
            case "newline":
              props.push(st);
              return true;
          }
      return false;
    }
    function setFlowScalarValue(token, source, type) {
      switch (token.type) {
        case "scalar":
        case "double-quoted-scalar":
        case "single-quoted-scalar":
          token.type = type;
          token.source = source;
          break;
        case "block-scalar": {
          const end = token.props.slice(1);
          let oa = source.length;
          if (token.props[0].type === "block-scalar-header")
            oa -= token.props[0].source.length;
          for (const tok of end)
            tok.offset += oa;
          delete token.props;
          Object.assign(token, { type, source, end });
          break;
        }
        case "block-map":
        case "block-seq": {
          const offset = token.offset + source.length;
          const nl = { type: "newline", offset, indent: token.indent, source: "\n" };
          delete token.items;
          Object.assign(token, { type, source, end: [nl] });
          break;
        }
        default: {
          const indent = "indent" in token ? token.indent : -1;
          const end = "end" in token && Array.isArray(token.end) ? token.end.filter((st) => st.type === "space" || st.type === "comment" || st.type === "newline") : [];
          for (const key of Object.keys(token))
            if (key !== "type" && key !== "offset")
              delete token[key];
          Object.assign(token, { type, indent, source, end });
        }
      }
    }
    exports2.createScalarToken = createScalarToken;
    exports2.resolveAsScalar = resolveAsScalar;
    exports2.setScalarValue = setScalarValue;
  }
});

// ../../node_modules/yaml/dist/parse/cst-stringify.js
var require_cst_stringify = __commonJS({
  "../../node_modules/yaml/dist/parse/cst-stringify.js"(exports2) {
    "use strict";
    var stringify = (cst) => "type" in cst ? stringifyToken(cst) : stringifyItem(cst);
    function stringifyToken(token) {
      switch (token.type) {
        case "block-scalar": {
          let res = "";
          for (const tok of token.props)
            res += stringifyToken(tok);
          return res + token.source;
        }
        case "block-map":
        case "block-seq": {
          let res = "";
          for (const item of token.items)
            res += stringifyItem(item);
          return res;
        }
        case "flow-collection": {
          let res = token.start.source;
          for (const item of token.items)
            res += stringifyItem(item);
          for (const st of token.end)
            res += st.source;
          return res;
        }
        case "document": {
          let res = stringifyItem(token);
          if (token.end)
            for (const st of token.end)
              res += st.source;
          return res;
        }
        default: {
          let res = token.source;
          if ("end" in token && token.end)
            for (const st of token.end)
              res += st.source;
          return res;
        }
      }
    }
    function stringifyItem({ start, key, sep, value }) {
      let res = "";
      for (const st of start)
        res += st.source;
      if (key)
        res += stringifyToken(key);
      if (sep)
        for (const st of sep)
          res += st.source;
      if (value)
        res += stringifyToken(value);
      return res;
    }
    exports2.stringify = stringify;
  }
});

// ../../node_modules/yaml/dist/parse/cst-visit.js
var require_cst_visit = __commonJS({
  "../../node_modules/yaml/dist/parse/cst-visit.js"(exports2) {
    "use strict";
    var BREAK = /* @__PURE__ */ Symbol("break visit");
    var SKIP = /* @__PURE__ */ Symbol("skip children");
    var REMOVE = /* @__PURE__ */ Symbol("remove item");
    function visit(cst, visitor) {
      if ("type" in cst && cst.type === "document")
        cst = { start: cst.start, value: cst.value };
      _visit(Object.freeze([]), cst, visitor);
    }
    visit.BREAK = BREAK;
    visit.SKIP = SKIP;
    visit.REMOVE = REMOVE;
    visit.itemAtPath = (cst, path27) => {
      let item = cst;
      for (const [field, index] of path27) {
        const tok = item?.[field];
        if (tok && "items" in tok) {
          item = tok.items[index];
        } else
          return void 0;
      }
      return item;
    };
    visit.parentCollection = (cst, path27) => {
      const parent = visit.itemAtPath(cst, path27.slice(0, -1));
      const field = path27[path27.length - 1][0];
      const coll = parent?.[field];
      if (coll && "items" in coll)
        return coll;
      throw new Error("Parent collection not found");
    };
    function _visit(path27, item, visitor) {
      let ctrl = visitor(item, path27);
      if (typeof ctrl === "symbol")
        return ctrl;
      for (const field of ["key", "value"]) {
        const token = item[field];
        if (token && "items" in token) {
          for (let i = 0; i < token.items.length; ++i) {
            const ci2 = _visit(Object.freeze(path27.concat([[field, i]])), token.items[i], visitor);
            if (typeof ci2 === "number")
              i = ci2 - 1;
            else if (ci2 === BREAK)
              return BREAK;
            else if (ci2 === REMOVE) {
              token.items.splice(i, 1);
              i -= 1;
            }
          }
          if (typeof ctrl === "function" && field === "key")
            ctrl = ctrl(item, path27);
        }
      }
      return typeof ctrl === "function" ? ctrl(item, path27) : ctrl;
    }
    exports2.visit = visit;
  }
});

// ../../node_modules/yaml/dist/parse/cst.js
var require_cst = __commonJS({
  "../../node_modules/yaml/dist/parse/cst.js"(exports2) {
    "use strict";
    var cstScalar = require_cst_scalar();
    var cstStringify = require_cst_stringify();
    var cstVisit = require_cst_visit();
    var BOM = "\uFEFF";
    var DOCUMENT = "";
    var FLOW_END = "";
    var SCALAR = "";
    var isCollection = (token) => !!token && "items" in token;
    var isScalar5 = (token) => !!token && (token.type === "scalar" || token.type === "single-quoted-scalar" || token.type === "double-quoted-scalar" || token.type === "block-scalar");
    function prettyToken(token) {
      switch (token) {
        case BOM:
          return "<BOM>";
        case DOCUMENT:
          return "<DOC>";
        case FLOW_END:
          return "<FLOW_END>";
        case SCALAR:
          return "<SCALAR>";
        default:
          return JSON.stringify(token);
      }
    }
    function tokenType(source) {
      switch (source) {
        case BOM:
          return "byte-order-mark";
        case DOCUMENT:
          return "doc-mode";
        case FLOW_END:
          return "flow-error-end";
        case SCALAR:
          return "scalar";
        case "---":
          return "doc-start";
        case "...":
          return "doc-end";
        case "":
        case "\n":
        case "\r\n":
          return "newline";
        case "-":
          return "seq-item-ind";
        case "?":
          return "explicit-key-ind";
        case ":":
          return "map-value-ind";
        case "{":
          return "flow-map-start";
        case "}":
          return "flow-map-end";
        case "[":
          return "flow-seq-start";
        case "]":
          return "flow-seq-end";
        case ",":
          return "comma";
      }
      switch (source[0]) {
        case " ":
        case "	":
          return "space";
        case "#":
          return "comment";
        case "%":
          return "directive-line";
        case "*":
          return "alias";
        case "&":
          return "anchor";
        case "!":
          return "tag";
        case "'":
          return "single-quoted-scalar";
        case '"':
          return "double-quoted-scalar";
        case "|":
        case ">":
          return "block-scalar-header";
      }
      return null;
    }
    exports2.createScalarToken = cstScalar.createScalarToken;
    exports2.resolveAsScalar = cstScalar.resolveAsScalar;
    exports2.setScalarValue = cstScalar.setScalarValue;
    exports2.stringify = cstStringify.stringify;
    exports2.visit = cstVisit.visit;
    exports2.BOM = BOM;
    exports2.DOCUMENT = DOCUMENT;
    exports2.FLOW_END = FLOW_END;
    exports2.SCALAR = SCALAR;
    exports2.isCollection = isCollection;
    exports2.isScalar = isScalar5;
    exports2.prettyToken = prettyToken;
    exports2.tokenType = tokenType;
  }
});

// ../../node_modules/yaml/dist/parse/lexer.js
var require_lexer = __commonJS({
  "../../node_modules/yaml/dist/parse/lexer.js"(exports2) {
    "use strict";
    var cst = require_cst();
    function isEmpty(ch) {
      switch (ch) {
        case void 0:
        case " ":
        case "\n":
        case "\r":
        case "	":
          return true;
        default:
          return false;
      }
    }
    var hexDigits = new Set("0123456789ABCDEFabcdef");
    var tagChars = new Set("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-#;/?:@&=+$_.!~*'()");
    var flowIndicatorChars = new Set(",[]{}");
    var invalidAnchorChars = new Set(" ,[]{}\n\r	");
    var isNotAnchorChar = (ch) => !ch || invalidAnchorChars.has(ch);
    var Lexer = class {
      constructor() {
        this.atEnd = false;
        this.blockScalarIndent = -1;
        this.blockScalarKeep = false;
        this.buffer = "";
        this.flowKey = false;
        this.flowLevel = 0;
        this.indentNext = 0;
        this.indentValue = 0;
        this.lineEndPos = null;
        this.next = null;
        this.pos = 0;
      }
      /**
       * Generate YAML tokens from the `source` string. If `incomplete`,
       * a part of the last line may be left as a buffer for the next call.
       *
       * @returns A generator of lexical tokens
       */
      *lex(source, incomplete = false) {
        if (source) {
          if (typeof source !== "string")
            throw TypeError("source is not a string");
          this.buffer = this.buffer ? this.buffer + source : source;
          this.lineEndPos = null;
        }
        this.atEnd = !incomplete;
        let next = this.next ?? "stream";
        while (next && (incomplete || this.hasChars(1)))
          next = yield* this.parseNext(next);
      }
      atLineEnd() {
        let i = this.pos;
        let ch = this.buffer[i];
        while (ch === " " || ch === "	")
          ch = this.buffer[++i];
        if (!ch || ch === "#" || ch === "\n")
          return true;
        if (ch === "\r")
          return this.buffer[i + 1] === "\n";
        return false;
      }
      charAt(n) {
        return this.buffer[this.pos + n];
      }
      continueScalar(offset) {
        let ch = this.buffer[offset];
        if (this.indentNext > 0) {
          let indent = 0;
          while (ch === " ")
            ch = this.buffer[++indent + offset];
          if (ch === "\r") {
            const next = this.buffer[indent + offset + 1];
            if (next === "\n" || !next && !this.atEnd)
              return offset + indent + 1;
          }
          return ch === "\n" || indent >= this.indentNext || !ch && !this.atEnd ? offset + indent : -1;
        }
        if (ch === "-" || ch === ".") {
          const dt = this.buffer.substr(offset, 3);
          if ((dt === "---" || dt === "...") && isEmpty(this.buffer[offset + 3]))
            return -1;
        }
        return offset;
      }
      getLine() {
        let end = this.lineEndPos;
        if (typeof end !== "number" || end !== -1 && end < this.pos) {
          end = this.buffer.indexOf("\n", this.pos);
          this.lineEndPos = end;
        }
        if (end === -1)
          return this.atEnd ? this.buffer.substring(this.pos) : null;
        if (this.buffer[end - 1] === "\r")
          end -= 1;
        return this.buffer.substring(this.pos, end);
      }
      hasChars(n) {
        return this.pos + n <= this.buffer.length;
      }
      setNext(state) {
        this.buffer = this.buffer.substring(this.pos);
        this.pos = 0;
        this.lineEndPos = null;
        this.next = state;
        return null;
      }
      peek(n) {
        return this.buffer.substr(this.pos, n);
      }
      *parseNext(next) {
        switch (next) {
          case "stream":
            return yield* this.parseStream();
          case "line-start":
            return yield* this.parseLineStart();
          case "block-start":
            return yield* this.parseBlockStart();
          case "doc":
            return yield* this.parseDocument();
          case "flow":
            return yield* this.parseFlowCollection();
          case "quoted-scalar":
            return yield* this.parseQuotedScalar();
          case "block-scalar":
            return yield* this.parseBlockScalar();
          case "plain-scalar":
            return yield* this.parsePlainScalar();
        }
      }
      *parseStream() {
        let line2 = this.getLine();
        if (line2 === null)
          return this.setNext("stream");
        if (line2[0] === cst.BOM) {
          yield* this.pushCount(1);
          line2 = line2.substring(1);
        }
        if (line2[0] === "%") {
          let dirEnd = line2.length;
          let cs = line2.indexOf("#");
          while (cs !== -1) {
            const ch = line2[cs - 1];
            if (ch === " " || ch === "	") {
              dirEnd = cs - 1;
              break;
            } else {
              cs = line2.indexOf("#", cs + 1);
            }
          }
          while (true) {
            const ch = line2[dirEnd - 1];
            if (ch === " " || ch === "	")
              dirEnd -= 1;
            else
              break;
          }
          const n = (yield* this.pushCount(dirEnd)) + (yield* this.pushSpaces(true));
          yield* this.pushCount(line2.length - n);
          this.pushNewline();
          return "stream";
        }
        if (this.atLineEnd()) {
          const sp = yield* this.pushSpaces(true);
          yield* this.pushCount(line2.length - sp);
          yield* this.pushNewline();
          return "stream";
        }
        yield cst.DOCUMENT;
        return yield* this.parseLineStart();
      }
      *parseLineStart() {
        const ch = this.charAt(0);
        if (!ch && !this.atEnd)
          return this.setNext("line-start");
        if (ch === "-" || ch === ".") {
          if (!this.atEnd && !this.hasChars(4))
            return this.setNext("line-start");
          const s = this.peek(3);
          if ((s === "---" || s === "...") && isEmpty(this.charAt(3))) {
            yield* this.pushCount(3);
            this.indentValue = 0;
            this.indentNext = 0;
            return s === "---" ? "doc" : "stream";
          }
        }
        this.indentValue = yield* this.pushSpaces(false);
        if (this.indentNext > this.indentValue && !isEmpty(this.charAt(1)))
          this.indentNext = this.indentValue;
        return yield* this.parseBlockStart();
      }
      *parseBlockStart() {
        const [ch0, ch1] = this.peek(2);
        if (!ch1 && !this.atEnd)
          return this.setNext("block-start");
        if ((ch0 === "-" || ch0 === "?" || ch0 === ":") && isEmpty(ch1)) {
          const n = (yield* this.pushCount(1)) + (yield* this.pushSpaces(true));
          this.indentNext = this.indentValue + 1;
          this.indentValue += n;
          return "block-start";
        }
        return "doc";
      }
      *parseDocument() {
        yield* this.pushSpaces(true);
        const line2 = this.getLine();
        if (line2 === null)
          return this.setNext("doc");
        let n = yield* this.pushIndicators();
        switch (line2[n]) {
          case "#":
            yield* this.pushCount(line2.length - n);
          // fallthrough
          case void 0:
            yield* this.pushNewline();
            return yield* this.parseLineStart();
          case "{":
          case "[":
            yield* this.pushCount(1);
            this.flowKey = false;
            this.flowLevel = 1;
            return "flow";
          case "}":
          case "]":
            yield* this.pushCount(1);
            return "doc";
          case "*":
            yield* this.pushUntil(isNotAnchorChar);
            return "doc";
          case '"':
          case "'":
            return yield* this.parseQuotedScalar();
          case "|":
          case ">":
            n += yield* this.parseBlockScalarHeader();
            n += yield* this.pushSpaces(true);
            yield* this.pushCount(line2.length - n);
            yield* this.pushNewline();
            return yield* this.parseBlockScalar();
          default:
            return yield* this.parsePlainScalar();
        }
      }
      *parseFlowCollection() {
        let nl, sp;
        let indent = -1;
        do {
          nl = yield* this.pushNewline();
          if (nl > 0) {
            sp = yield* this.pushSpaces(false);
            this.indentValue = indent = sp;
          } else {
            sp = 0;
          }
          sp += yield* this.pushSpaces(true);
        } while (nl + sp > 0);
        const line2 = this.getLine();
        if (line2 === null)
          return this.setNext("flow");
        if (indent !== -1 && indent < this.indentNext && line2[0] !== "#" || indent === 0 && (line2.startsWith("---") || line2.startsWith("...")) && isEmpty(line2[3])) {
          const atFlowEndMarker = indent === this.indentNext - 1 && this.flowLevel === 1 && (line2[0] === "]" || line2[0] === "}");
          if (!atFlowEndMarker) {
            this.flowLevel = 0;
            yield cst.FLOW_END;
            return yield* this.parseLineStart();
          }
        }
        let n = 0;
        while (line2[n] === ",") {
          n += yield* this.pushCount(1);
          n += yield* this.pushSpaces(true);
          this.flowKey = false;
        }
        n += yield* this.pushIndicators();
        switch (line2[n]) {
          case void 0:
            return "flow";
          case "#":
            yield* this.pushCount(line2.length - n);
            return "flow";
          case "{":
          case "[":
            yield* this.pushCount(1);
            this.flowKey = false;
            this.flowLevel += 1;
            return "flow";
          case "}":
          case "]":
            yield* this.pushCount(1);
            this.flowKey = true;
            this.flowLevel -= 1;
            return this.flowLevel ? "flow" : "doc";
          case "*":
            yield* this.pushUntil(isNotAnchorChar);
            return "flow";
          case '"':
          case "'":
            this.flowKey = true;
            return yield* this.parseQuotedScalar();
          case ":": {
            const next = this.charAt(1);
            if (this.flowKey || isEmpty(next) || next === ",") {
              this.flowKey = false;
              yield* this.pushCount(1);
              yield* this.pushSpaces(true);
              return "flow";
            }
          }
          // fallthrough
          default:
            this.flowKey = false;
            return yield* this.parsePlainScalar();
        }
      }
      *parseQuotedScalar() {
        const quote = this.charAt(0);
        let end = this.buffer.indexOf(quote, this.pos + 1);
        if (quote === "'") {
          while (end !== -1 && this.buffer[end + 1] === "'")
            end = this.buffer.indexOf("'", end + 2);
        } else {
          while (end !== -1) {
            let n = 0;
            while (this.buffer[end - 1 - n] === "\\")
              n += 1;
            if (n % 2 === 0)
              break;
            end = this.buffer.indexOf('"', end + 1);
          }
        }
        const qb = this.buffer.substring(0, end);
        let nl = qb.indexOf("\n", this.pos);
        if (nl !== -1) {
          while (nl !== -1) {
            const cs = this.continueScalar(nl + 1);
            if (cs === -1)
              break;
            nl = qb.indexOf("\n", cs);
          }
          if (nl !== -1) {
            end = nl - (qb[nl - 1] === "\r" ? 2 : 1);
          }
        }
        if (end === -1) {
          if (!this.atEnd)
            return this.setNext("quoted-scalar");
          end = this.buffer.length;
        }
        yield* this.pushToIndex(end + 1, false);
        return this.flowLevel ? "flow" : "doc";
      }
      *parseBlockScalarHeader() {
        this.blockScalarIndent = -1;
        this.blockScalarKeep = false;
        let i = this.pos;
        while (true) {
          const ch = this.buffer[++i];
          if (ch === "+")
            this.blockScalarKeep = true;
          else if (ch > "0" && ch <= "9")
            this.blockScalarIndent = Number(ch) - 1;
          else if (ch !== "-")
            break;
        }
        return yield* this.pushUntil((ch) => isEmpty(ch) || ch === "#");
      }
      *parseBlockScalar() {
        let nl = this.pos - 1;
        let indent = 0;
        let ch;
        loop: for (let i2 = this.pos; ch = this.buffer[i2]; ++i2) {
          switch (ch) {
            case " ":
              indent += 1;
              break;
            case "\n":
              nl = i2;
              indent = 0;
              break;
            case "\r": {
              const next = this.buffer[i2 + 1];
              if (!next && !this.atEnd)
                return this.setNext("block-scalar");
              if (next === "\n")
                break;
            }
            // fallthrough
            default:
              break loop;
          }
        }
        if (!ch && !this.atEnd)
          return this.setNext("block-scalar");
        if (indent >= this.indentNext) {
          if (this.blockScalarIndent === -1)
            this.indentNext = indent;
          else {
            this.indentNext = this.blockScalarIndent + (this.indentNext === 0 ? 1 : this.indentNext);
          }
          do {
            const cs = this.continueScalar(nl + 1);
            if (cs === -1)
              break;
            nl = this.buffer.indexOf("\n", cs);
          } while (nl !== -1);
          if (nl === -1) {
            if (!this.atEnd)
              return this.setNext("block-scalar");
            nl = this.buffer.length;
          }
        }
        let i = nl + 1;
        ch = this.buffer[i];
        while (ch === " ")
          ch = this.buffer[++i];
        if (ch === "	") {
          while (ch === "	" || ch === " " || ch === "\r" || ch === "\n")
            ch = this.buffer[++i];
          nl = i - 1;
        } else if (!this.blockScalarKeep) {
          do {
            let i2 = nl - 1;
            let ch2 = this.buffer[i2];
            if (ch2 === "\r")
              ch2 = this.buffer[--i2];
            const lastChar = i2;
            while (ch2 === " ")
              ch2 = this.buffer[--i2];
            if (ch2 === "\n" && i2 >= this.pos && i2 + 1 + indent > lastChar)
              nl = i2;
            else
              break;
          } while (true);
        }
        yield cst.SCALAR;
        yield* this.pushToIndex(nl + 1, true);
        return yield* this.parseLineStart();
      }
      *parsePlainScalar() {
        const inFlow = this.flowLevel > 0;
        let end = this.pos - 1;
        let i = this.pos - 1;
        let ch;
        while (ch = this.buffer[++i]) {
          if (ch === ":") {
            const next = this.buffer[i + 1];
            if (isEmpty(next) || inFlow && flowIndicatorChars.has(next))
              break;
            end = i;
          } else if (isEmpty(ch)) {
            let next = this.buffer[i + 1];
            if (ch === "\r") {
              if (next === "\n") {
                i += 1;
                ch = "\n";
                next = this.buffer[i + 1];
              } else
                end = i;
            }
            if (next === "#" || inFlow && flowIndicatorChars.has(next))
              break;
            if (ch === "\n") {
              const cs = this.continueScalar(i + 1);
              if (cs === -1)
                break;
              i = Math.max(i, cs - 2);
            }
          } else {
            if (inFlow && flowIndicatorChars.has(ch))
              break;
            end = i;
          }
        }
        if (!ch && !this.atEnd)
          return this.setNext("plain-scalar");
        yield cst.SCALAR;
        yield* this.pushToIndex(end + 1, true);
        return inFlow ? "flow" : "doc";
      }
      *pushCount(n) {
        if (n > 0) {
          yield this.buffer.substr(this.pos, n);
          this.pos += n;
          return n;
        }
        return 0;
      }
      *pushToIndex(i, allowEmpty) {
        const s = this.buffer.slice(this.pos, i);
        if (s) {
          yield s;
          this.pos += s.length;
          return s.length;
        } else if (allowEmpty)
          yield "";
        return 0;
      }
      *pushIndicators() {
        let n = 0;
        loop: while (true) {
          switch (this.charAt(0)) {
            case "!":
              n += yield* this.pushTag();
              n += yield* this.pushSpaces(true);
              continue loop;
            case "&":
              n += yield* this.pushUntil(isNotAnchorChar);
              n += yield* this.pushSpaces(true);
              continue loop;
            case "-":
            // this is an error
            case "?":
            // this is an error outside flow collections
            case ":": {
              const inFlow = this.flowLevel > 0;
              const ch1 = this.charAt(1);
              if (isEmpty(ch1) || inFlow && flowIndicatorChars.has(ch1)) {
                if (!inFlow)
                  this.indentNext = this.indentValue + 1;
                else if (this.flowKey)
                  this.flowKey = false;
                n += yield* this.pushCount(1);
                n += yield* this.pushSpaces(true);
                continue loop;
              }
            }
          }
          break loop;
        }
        return n;
      }
      *pushTag() {
        if (this.charAt(1) === "<") {
          let i = this.pos + 2;
          let ch = this.buffer[i];
          while (!isEmpty(ch) && ch !== ">")
            ch = this.buffer[++i];
          return yield* this.pushToIndex(ch === ">" ? i + 1 : i, false);
        } else {
          let i = this.pos + 1;
          let ch = this.buffer[i];
          while (ch) {
            if (tagChars.has(ch))
              ch = this.buffer[++i];
            else if (ch === "%" && hexDigits.has(this.buffer[i + 1]) && hexDigits.has(this.buffer[i + 2])) {
              ch = this.buffer[i += 3];
            } else
              break;
          }
          return yield* this.pushToIndex(i, false);
        }
      }
      *pushNewline() {
        const ch = this.buffer[this.pos];
        if (ch === "\n")
          return yield* this.pushCount(1);
        else if (ch === "\r" && this.charAt(1) === "\n")
          return yield* this.pushCount(2);
        else
          return 0;
      }
      *pushSpaces(allowTabs) {
        let i = this.pos - 1;
        let ch;
        do {
          ch = this.buffer[++i];
        } while (ch === " " || allowTabs && ch === "	");
        const n = i - this.pos;
        if (n > 0) {
          yield this.buffer.substr(this.pos, n);
          this.pos = i;
        }
        return n;
      }
      *pushUntil(test) {
        let i = this.pos;
        let ch = this.buffer[i];
        while (!test(ch))
          ch = this.buffer[++i];
        return yield* this.pushToIndex(i, false);
      }
    };
    exports2.Lexer = Lexer;
  }
});

// ../../node_modules/yaml/dist/parse/line-counter.js
var require_line_counter = __commonJS({
  "../../node_modules/yaml/dist/parse/line-counter.js"(exports2) {
    "use strict";
    var LineCounter3 = class {
      constructor() {
        this.lineStarts = [];
        this.addNewLine = (offset) => this.lineStarts.push(offset);
        this.linePos = (offset) => {
          let low = 0;
          let high = this.lineStarts.length;
          while (low < high) {
            const mid = low + high >> 1;
            if (this.lineStarts[mid] < offset)
              low = mid + 1;
            else
              high = mid;
          }
          if (this.lineStarts[low] === offset)
            return { line: low + 1, col: 1 };
          if (low === 0)
            return { line: 0, col: offset };
          const start = this.lineStarts[low - 1];
          return { line: low, col: offset - start + 1 };
        };
      }
    };
    exports2.LineCounter = LineCounter3;
  }
});

// ../../node_modules/yaml/dist/parse/parser.js
var require_parser = __commonJS({
  "../../node_modules/yaml/dist/parse/parser.js"(exports2) {
    "use strict";
    var node_process = require("process");
    var cst = require_cst();
    var lexer = require_lexer();
    function includesToken(list, type) {
      for (let i = 0; i < list.length; ++i)
        if (list[i].type === type)
          return true;
      return false;
    }
    function findNonEmptyIndex(list) {
      for (let i = 0; i < list.length; ++i) {
        switch (list[i].type) {
          case "space":
          case "comment":
          case "newline":
            break;
          default:
            return i;
        }
      }
      return -1;
    }
    function isFlowToken(token) {
      switch (token?.type) {
        case "alias":
        case "scalar":
        case "single-quoted-scalar":
        case "double-quoted-scalar":
        case "flow-collection":
          return true;
        default:
          return false;
      }
    }
    function getPrevProps(parent) {
      switch (parent.type) {
        case "document":
          return parent.start;
        case "block-map": {
          const it = parent.items[parent.items.length - 1];
          return it.sep ?? it.start;
        }
        case "block-seq":
          return parent.items[parent.items.length - 1].start;
        /* istanbul ignore next should not happen */
        default:
          return [];
      }
    }
    function getFirstKeyStartProps(prev) {
      if (prev.length === 0)
        return [];
      let i = prev.length;
      loop: while (--i >= 0) {
        switch (prev[i].type) {
          case "doc-start":
          case "explicit-key-ind":
          case "map-value-ind":
          case "seq-item-ind":
          case "newline":
            break loop;
        }
      }
      while (prev[++i]?.type === "space") {
      }
      return prev.splice(i, prev.length);
    }
    function arrayPushArray(target, source) {
      if (source.length < 1e5)
        Array.prototype.push.apply(target, source);
      else
        for (let i = 0; i < source.length; ++i)
          target.push(source[i]);
    }
    function fixFlowSeqItems(fc) {
      if (fc.start.type === "flow-seq-start") {
        for (const it of fc.items) {
          if (it.sep && !it.value && !includesToken(it.start, "explicit-key-ind") && !includesToken(it.sep, "map-value-ind")) {
            if (it.key)
              it.value = it.key;
            delete it.key;
            if (isFlowToken(it.value)) {
              if (it.value.end)
                arrayPushArray(it.value.end, it.sep);
              else
                it.value.end = it.sep;
            } else
              arrayPushArray(it.start, it.sep);
            delete it.sep;
          }
        }
      }
    }
    var Parser = class {
      /**
       * @param onNewLine - If defined, called separately with the start position of
       *   each new line (in `parse()`, including the start of input).
       */
      constructor(onNewLine) {
        this.atNewLine = true;
        this.atScalar = false;
        this.indent = 0;
        this.offset = 0;
        this.onKeyLine = false;
        this.stack = [];
        this.source = "";
        this.type = "";
        this.lexer = new lexer.Lexer();
        this.onNewLine = onNewLine;
      }
      /**
       * Parse `source` as a YAML stream.
       * If `incomplete`, a part of the last line may be left as a buffer for the next call.
       *
       * Errors are not thrown, but yielded as `{ type: 'error', message }` tokens.
       *
       * @returns A generator of tokens representing each directive, document, and other structure.
       */
      *parse(source, incomplete = false) {
        if (this.onNewLine && this.offset === 0)
          this.onNewLine(0);
        for (const lexeme of this.lexer.lex(source, incomplete))
          yield* this.next(lexeme);
        if (!incomplete)
          yield* this.end();
      }
      /**
       * Advance the parser by the `source` of one lexical token.
       */
      *next(source) {
        this.source = source;
        if (node_process.env.LOG_TOKENS)
          console.log("|", cst.prettyToken(source));
        if (this.atScalar) {
          this.atScalar = false;
          yield* this.step();
          this.offset += source.length;
          return;
        }
        const type = cst.tokenType(source);
        if (!type) {
          const message = `Not a YAML token: ${source}`;
          yield* this.pop({ type: "error", offset: this.offset, message, source });
          this.offset += source.length;
        } else if (type === "scalar") {
          this.atNewLine = false;
          this.atScalar = true;
          this.type = "scalar";
        } else {
          this.type = type;
          yield* this.step();
          switch (type) {
            case "newline":
              this.atNewLine = true;
              this.indent = 0;
              if (this.onNewLine)
                this.onNewLine(this.offset + source.length);
              break;
            case "space":
              if (this.atNewLine && source[0] === " ")
                this.indent += source.length;
              break;
            case "explicit-key-ind":
            case "map-value-ind":
            case "seq-item-ind":
              if (this.atNewLine)
                this.indent += source.length;
              break;
            case "doc-mode":
            case "flow-error-end":
              return;
            default:
              this.atNewLine = false;
          }
          this.offset += source.length;
        }
      }
      /** Call at end of input to push out any remaining constructions */
      *end() {
        while (this.stack.length > 0)
          yield* this.pop();
      }
      get sourceToken() {
        const st = {
          type: this.type,
          offset: this.offset,
          indent: this.indent,
          source: this.source
        };
        return st;
      }
      *step() {
        const top = this.peek(1);
        if (this.type === "doc-end" && top?.type !== "doc-end") {
          while (this.stack.length > 0)
            yield* this.pop();
          this.stack.push({
            type: "doc-end",
            offset: this.offset,
            source: this.source
          });
          return;
        }
        if (!top)
          return yield* this.stream();
        switch (top.type) {
          case "document":
            return yield* this.document(top);
          case "alias":
          case "scalar":
          case "single-quoted-scalar":
          case "double-quoted-scalar":
            return yield* this.scalar(top);
          case "block-scalar":
            return yield* this.blockScalar(top);
          case "block-map":
            return yield* this.blockMap(top);
          case "block-seq":
            return yield* this.blockSequence(top);
          case "flow-collection":
            return yield* this.flowCollection(top);
          case "doc-end":
            return yield* this.documentEnd(top);
        }
        yield* this.pop();
      }
      peek(n) {
        return this.stack[this.stack.length - n];
      }
      *pop(error) {
        const token = error ?? this.stack.pop();
        if (!token) {
          const message = "Tried to pop an empty stack";
          yield { type: "error", offset: this.offset, source: "", message };
        } else if (this.stack.length === 0) {
          yield token;
        } else {
          const top = this.peek(1);
          if (token.type === "block-scalar") {
            token.indent = "indent" in top ? top.indent : 0;
          } else if (token.type === "flow-collection" && top.type === "document") {
            token.indent = 0;
          }
          if (token.type === "flow-collection")
            fixFlowSeqItems(token);
          switch (top.type) {
            case "document":
              top.value = token;
              break;
            case "block-scalar":
              top.props.push(token);
              break;
            case "block-map": {
              const it = top.items[top.items.length - 1];
              if (it.value) {
                top.items.push({ start: [], key: token, sep: [] });
                this.onKeyLine = true;
                return;
              } else if (it.sep) {
                it.value = token;
              } else {
                Object.assign(it, { key: token, sep: [] });
                this.onKeyLine = !it.explicitKey;
                return;
              }
              break;
            }
            case "block-seq": {
              const it = top.items[top.items.length - 1];
              if (it.value)
                top.items.push({ start: [], value: token });
              else
                it.value = token;
              break;
            }
            case "flow-collection": {
              const it = top.items[top.items.length - 1];
              if (!it || it.value)
                top.items.push({ start: [], key: token, sep: [] });
              else if (it.sep)
                it.value = token;
              else
                Object.assign(it, { key: token, sep: [] });
              return;
            }
            /* istanbul ignore next should not happen */
            default:
              yield* this.pop();
              yield* this.pop(token);
          }
          if ((top.type === "document" || top.type === "block-map" || top.type === "block-seq") && (token.type === "block-map" || token.type === "block-seq")) {
            const last = token.items[token.items.length - 1];
            if (last && !last.sep && !last.value && last.start.length > 0 && findNonEmptyIndex(last.start) === -1 && (token.indent === 0 || last.start.every((st) => st.type !== "comment" || st.indent < token.indent))) {
              if (top.type === "document")
                top.end = last.start;
              else
                top.items.push({ start: last.start });
              token.items.splice(-1, 1);
            }
          }
        }
      }
      *stream() {
        switch (this.type) {
          case "directive-line":
            yield { type: "directive", offset: this.offset, source: this.source };
            return;
          case "byte-order-mark":
          case "space":
          case "comment":
          case "newline":
            yield this.sourceToken;
            return;
          case "doc-mode":
          case "doc-start": {
            const doc = {
              type: "document",
              offset: this.offset,
              start: []
            };
            if (this.type === "doc-start")
              doc.start.push(this.sourceToken);
            this.stack.push(doc);
            return;
          }
        }
        yield {
          type: "error",
          offset: this.offset,
          message: `Unexpected ${this.type} token in YAML stream`,
          source: this.source
        };
      }
      *document(doc) {
        if (doc.value)
          return yield* this.lineEnd(doc);
        switch (this.type) {
          case "doc-start": {
            if (findNonEmptyIndex(doc.start) !== -1) {
              yield* this.pop();
              yield* this.step();
            } else
              doc.start.push(this.sourceToken);
            return;
          }
          case "anchor":
          case "tag":
          case "space":
          case "comment":
          case "newline":
            doc.start.push(this.sourceToken);
            return;
        }
        const bv = this.startBlockValue(doc);
        if (bv)
          this.stack.push(bv);
        else {
          yield {
            type: "error",
            offset: this.offset,
            message: `Unexpected ${this.type} token in YAML document`,
            source: this.source
          };
        }
      }
      *scalar(scalar) {
        if (this.type === "map-value-ind") {
          const prev = getPrevProps(this.peek(2));
          const start = getFirstKeyStartProps(prev);
          let sep;
          if (scalar.end) {
            sep = scalar.end;
            sep.push(this.sourceToken);
            delete scalar.end;
          } else
            sep = [this.sourceToken];
          const map = {
            type: "block-map",
            offset: scalar.offset,
            indent: scalar.indent,
            items: [{ start, key: scalar, sep }]
          };
          this.onKeyLine = true;
          this.stack[this.stack.length - 1] = map;
        } else
          yield* this.lineEnd(scalar);
      }
      *blockScalar(scalar) {
        switch (this.type) {
          case "space":
          case "comment":
          case "newline":
            scalar.props.push(this.sourceToken);
            return;
          case "scalar":
            scalar.source = this.source;
            this.atNewLine = true;
            this.indent = 0;
            if (this.onNewLine) {
              let nl = this.source.indexOf("\n") + 1;
              while (nl !== 0) {
                this.onNewLine(this.offset + nl);
                nl = this.source.indexOf("\n", nl) + 1;
              }
            }
            yield* this.pop();
            break;
          /* istanbul ignore next should not happen */
          default:
            yield* this.pop();
            yield* this.step();
        }
      }
      *blockMap(map) {
        const it = map.items[map.items.length - 1];
        switch (this.type) {
          case "newline":
            this.onKeyLine = false;
            if (it.value) {
              const end = "end" in it.value ? it.value.end : void 0;
              const last = Array.isArray(end) ? end[end.length - 1] : void 0;
              if (last?.type === "comment")
                end?.push(this.sourceToken);
              else
                map.items.push({ start: [this.sourceToken] });
            } else if (it.sep) {
              it.sep.push(this.sourceToken);
            } else {
              it.start.push(this.sourceToken);
            }
            return;
          case "space":
          case "comment":
            if (it.value) {
              map.items.push({ start: [this.sourceToken] });
            } else if (it.sep) {
              it.sep.push(this.sourceToken);
            } else {
              if (this.atIndentedComment(it.start, map.indent)) {
                const prev = map.items[map.items.length - 2];
                const end = prev?.value?.end;
                if (Array.isArray(end)) {
                  arrayPushArray(end, it.start);
                  end.push(this.sourceToken);
                  map.items.pop();
                  return;
                }
              }
              it.start.push(this.sourceToken);
            }
            return;
        }
        if (this.indent >= map.indent) {
          const atMapIndent = !this.onKeyLine && this.indent === map.indent;
          const atNextItem = atMapIndent && (it.sep || it.explicitKey) && this.type !== "seq-item-ind";
          let start = [];
          if (atNextItem && it.sep && !it.value) {
            const nl = [];
            for (let i = 0; i < it.sep.length; ++i) {
              const st = it.sep[i];
              switch (st.type) {
                case "newline":
                  nl.push(i);
                  break;
                case "space":
                  break;
                case "comment":
                  if (st.indent > map.indent)
                    nl.length = 0;
                  break;
                default:
                  nl.length = 0;
              }
            }
            if (nl.length >= 2)
              start = it.sep.splice(nl[1]);
          }
          switch (this.type) {
            case "anchor":
            case "tag":
              if (atNextItem || it.value) {
                start.push(this.sourceToken);
                map.items.push({ start });
                this.onKeyLine = true;
              } else if (it.sep) {
                it.sep.push(this.sourceToken);
              } else {
                it.start.push(this.sourceToken);
              }
              return;
            case "explicit-key-ind":
              if (!it.sep && !it.explicitKey) {
                it.start.push(this.sourceToken);
                it.explicitKey = true;
              } else if (atNextItem || it.value) {
                start.push(this.sourceToken);
                map.items.push({ start, explicitKey: true });
              } else {
                this.stack.push({
                  type: "block-map",
                  offset: this.offset,
                  indent: this.indent,
                  items: [{ start: [this.sourceToken], explicitKey: true }]
                });
              }
              this.onKeyLine = true;
              return;
            case "map-value-ind":
              if (it.explicitKey) {
                if (!it.sep) {
                  if (includesToken(it.start, "newline")) {
                    Object.assign(it, { key: null, sep: [this.sourceToken] });
                  } else {
                    const start2 = getFirstKeyStartProps(it.start);
                    this.stack.push({
                      type: "block-map",
                      offset: this.offset,
                      indent: this.indent,
                      items: [{ start: start2, key: null, sep: [this.sourceToken] }]
                    });
                  }
                } else if (it.value) {
                  map.items.push({ start: [], key: null, sep: [this.sourceToken] });
                } else if (includesToken(it.sep, "map-value-ind")) {
                  this.stack.push({
                    type: "block-map",
                    offset: this.offset,
                    indent: this.indent,
                    items: [{ start, key: null, sep: [this.sourceToken] }]
                  });
                } else if (isFlowToken(it.key) && !includesToken(it.sep, "newline")) {
                  const start2 = getFirstKeyStartProps(it.start);
                  const key = it.key;
                  const sep = it.sep;
                  sep.push(this.sourceToken);
                  delete it.key;
                  delete it.sep;
                  this.stack.push({
                    type: "block-map",
                    offset: this.offset,
                    indent: this.indent,
                    items: [{ start: start2, key, sep }]
                  });
                } else if (start.length > 0) {
                  it.sep = it.sep.concat(start, this.sourceToken);
                } else {
                  it.sep.push(this.sourceToken);
                }
              } else {
                if (!it.sep) {
                  Object.assign(it, { key: null, sep: [this.sourceToken] });
                } else if (it.value || atNextItem) {
                  map.items.push({ start, key: null, sep: [this.sourceToken] });
                } else if (includesToken(it.sep, "map-value-ind")) {
                  this.stack.push({
                    type: "block-map",
                    offset: this.offset,
                    indent: this.indent,
                    items: [{ start: [], key: null, sep: [this.sourceToken] }]
                  });
                } else {
                  it.sep.push(this.sourceToken);
                }
              }
              this.onKeyLine = true;
              return;
            case "alias":
            case "scalar":
            case "single-quoted-scalar":
            case "double-quoted-scalar": {
              const fs31 = this.flowScalar(this.type);
              if (atNextItem || it.value) {
                map.items.push({ start, key: fs31, sep: [] });
                this.onKeyLine = true;
              } else if (it.sep) {
                this.stack.push(fs31);
              } else {
                Object.assign(it, { key: fs31, sep: [] });
                this.onKeyLine = true;
              }
              return;
            }
            default: {
              const bv = this.startBlockValue(map);
              if (bv) {
                if (bv.type === "block-seq") {
                  if (!it.explicitKey && it.sep && !includesToken(it.sep, "newline")) {
                    yield* this.pop({
                      type: "error",
                      offset: this.offset,
                      message: "Unexpected block-seq-ind on same line with key",
                      source: this.source
                    });
                    return;
                  }
                } else if (atMapIndent) {
                  map.items.push({ start });
                }
                this.stack.push(bv);
                return;
              }
            }
          }
        }
        yield* this.pop();
        yield* this.step();
      }
      *blockSequence(seq) {
        const it = seq.items[seq.items.length - 1];
        switch (this.type) {
          case "newline":
            if (it.value) {
              const end = "end" in it.value ? it.value.end : void 0;
              const last = Array.isArray(end) ? end[end.length - 1] : void 0;
              if (last?.type === "comment")
                end?.push(this.sourceToken);
              else
                seq.items.push({ start: [this.sourceToken] });
            } else
              it.start.push(this.sourceToken);
            return;
          case "space":
          case "comment":
            if (it.value)
              seq.items.push({ start: [this.sourceToken] });
            else {
              if (this.atIndentedComment(it.start, seq.indent)) {
                const prev = seq.items[seq.items.length - 2];
                const end = prev?.value?.end;
                if (Array.isArray(end)) {
                  arrayPushArray(end, it.start);
                  end.push(this.sourceToken);
                  seq.items.pop();
                  return;
                }
              }
              it.start.push(this.sourceToken);
            }
            return;
          case "anchor":
          case "tag":
            if (it.value || this.indent <= seq.indent)
              break;
            it.start.push(this.sourceToken);
            return;
          case "seq-item-ind":
            if (this.indent !== seq.indent)
              break;
            if (it.value || includesToken(it.start, "seq-item-ind"))
              seq.items.push({ start: [this.sourceToken] });
            else
              it.start.push(this.sourceToken);
            return;
        }
        if (this.indent > seq.indent) {
          const bv = this.startBlockValue(seq);
          if (bv) {
            this.stack.push(bv);
            return;
          }
        }
        yield* this.pop();
        yield* this.step();
      }
      *flowCollection(fc) {
        const it = fc.items[fc.items.length - 1];
        if (this.type === "flow-error-end") {
          let top;
          do {
            yield* this.pop();
            top = this.peek(1);
          } while (top?.type === "flow-collection");
        } else if (fc.end.length === 0) {
          switch (this.type) {
            case "comma":
            case "explicit-key-ind":
              if (!it || it.sep)
                fc.items.push({ start: [this.sourceToken] });
              else
                it.start.push(this.sourceToken);
              return;
            case "map-value-ind":
              if (!it || it.value)
                fc.items.push({ start: [], key: null, sep: [this.sourceToken] });
              else if (it.sep)
                it.sep.push(this.sourceToken);
              else
                Object.assign(it, { key: null, sep: [this.sourceToken] });
              return;
            case "space":
            case "comment":
            case "newline":
            case "anchor":
            case "tag":
              if (!it || it.value)
                fc.items.push({ start: [this.sourceToken] });
              else if (it.sep)
                it.sep.push(this.sourceToken);
              else
                it.start.push(this.sourceToken);
              return;
            case "alias":
            case "scalar":
            case "single-quoted-scalar":
            case "double-quoted-scalar": {
              const fs31 = this.flowScalar(this.type);
              if (!it || it.value)
                fc.items.push({ start: [], key: fs31, sep: [] });
              else if (it.sep)
                this.stack.push(fs31);
              else
                Object.assign(it, { key: fs31, sep: [] });
              return;
            }
            case "flow-map-end":
            case "flow-seq-end":
              fc.end.push(this.sourceToken);
              return;
          }
          const bv = this.startBlockValue(fc);
          if (bv)
            this.stack.push(bv);
          else {
            yield* this.pop();
            yield* this.step();
          }
        } else {
          const parent = this.peek(2);
          if (parent.type === "block-map" && (this.type === "map-value-ind" && parent.indent === fc.indent || this.type === "newline" && !parent.items[parent.items.length - 1].sep)) {
            yield* this.pop();
            yield* this.step();
          } else if (this.type === "map-value-ind" && parent.type !== "flow-collection") {
            const prev = getPrevProps(parent);
            const start = getFirstKeyStartProps(prev);
            fixFlowSeqItems(fc);
            const sep = fc.end.splice(1, fc.end.length);
            sep.push(this.sourceToken);
            const map = {
              type: "block-map",
              offset: fc.offset,
              indent: fc.indent,
              items: [{ start, key: fc, sep }]
            };
            this.onKeyLine = true;
            this.stack[this.stack.length - 1] = map;
          } else {
            yield* this.lineEnd(fc);
          }
        }
      }
      flowScalar(type) {
        if (this.onNewLine) {
          let nl = this.source.indexOf("\n") + 1;
          while (nl !== 0) {
            this.onNewLine(this.offset + nl);
            nl = this.source.indexOf("\n", nl) + 1;
          }
        }
        return {
          type,
          offset: this.offset,
          indent: this.indent,
          source: this.source
        };
      }
      startBlockValue(parent) {
        switch (this.type) {
          case "alias":
          case "scalar":
          case "single-quoted-scalar":
          case "double-quoted-scalar":
            return this.flowScalar(this.type);
          case "block-scalar-header":
            return {
              type: "block-scalar",
              offset: this.offset,
              indent: this.indent,
              props: [this.sourceToken],
              source: ""
            };
          case "flow-map-start":
          case "flow-seq-start":
            return {
              type: "flow-collection",
              offset: this.offset,
              indent: this.indent,
              start: this.sourceToken,
              items: [],
              end: []
            };
          case "seq-item-ind":
            return {
              type: "block-seq",
              offset: this.offset,
              indent: this.indent,
              items: [{ start: [this.sourceToken] }]
            };
          case "explicit-key-ind": {
            this.onKeyLine = true;
            const prev = getPrevProps(parent);
            const start = getFirstKeyStartProps(prev);
            start.push(this.sourceToken);
            return {
              type: "block-map",
              offset: this.offset,
              indent: this.indent,
              items: [{ start, explicitKey: true }]
            };
          }
          case "map-value-ind": {
            this.onKeyLine = true;
            const prev = getPrevProps(parent);
            const start = getFirstKeyStartProps(prev);
            return {
              type: "block-map",
              offset: this.offset,
              indent: this.indent,
              items: [{ start, key: null, sep: [this.sourceToken] }]
            };
          }
        }
        return null;
      }
      atIndentedComment(start, indent) {
        if (this.type !== "comment")
          return false;
        if (this.indent <= indent)
          return false;
        return start.every((st) => st.type === "newline" || st.type === "space");
      }
      *documentEnd(docEnd) {
        if (this.type !== "doc-mode") {
          if (docEnd.end)
            docEnd.end.push(this.sourceToken);
          else
            docEnd.end = [this.sourceToken];
          if (this.type === "newline")
            yield* this.pop();
        }
      }
      *lineEnd(token) {
        switch (this.type) {
          case "comma":
          case "doc-start":
          case "doc-end":
          case "flow-seq-end":
          case "flow-map-end":
          case "map-value-ind":
            yield* this.pop();
            yield* this.step();
            break;
          case "newline":
            this.onKeyLine = false;
          // fallthrough
          case "space":
          case "comment":
          default:
            if (token.end)
              token.end.push(this.sourceToken);
            else
              token.end = [this.sourceToken];
            if (this.type === "newline")
              yield* this.pop();
        }
      }
    };
    exports2.Parser = Parser;
  }
});

// ../../node_modules/yaml/dist/public-api.js
var require_public_api = __commonJS({
  "../../node_modules/yaml/dist/public-api.js"(exports2) {
    "use strict";
    var composer = require_composer();
    var Document = require_Document();
    var errors = require_errors();
    var log = require_log();
    var identity = require_identity();
    var lineCounter = require_line_counter();
    var parser = require_parser();
    function parseOptions(options) {
      const prettyErrors = options.prettyErrors !== false;
      const lineCounter$1 = options.lineCounter || prettyErrors && new lineCounter.LineCounter() || null;
      return { lineCounter: lineCounter$1, prettyErrors };
    }
    function parseAllDocuments4(source, options = {}) {
      const { lineCounter: lineCounter2, prettyErrors } = parseOptions(options);
      const parser$1 = new parser.Parser(lineCounter2?.addNewLine);
      const composer$1 = new composer.Composer(options);
      const docs = Array.from(composer$1.compose(parser$1.parse(source)));
      if (prettyErrors && lineCounter2)
        for (const doc of docs) {
          doc.errors.forEach(errors.prettifyError(source, lineCounter2));
          doc.warnings.forEach(errors.prettifyError(source, lineCounter2));
        }
      if (docs.length > 0)
        return docs;
      return Object.assign([], { empty: true }, composer$1.streamInfo());
    }
    function parseDocument2(source, options = {}) {
      const { lineCounter: lineCounter2, prettyErrors } = parseOptions(options);
      const parser$1 = new parser.Parser(lineCounter2?.addNewLine);
      const composer$1 = new composer.Composer(options);
      let doc = null;
      for (const _doc of composer$1.compose(parser$1.parse(source), true, source.length)) {
        if (!doc)
          doc = _doc;
        else if (doc.options.logLevel !== "silent") {
          doc.errors.push(new errors.YAMLParseError(_doc.range.slice(0, 2), "MULTIPLE_DOCS", "Source contains multiple documents; please use YAML.parseAllDocuments()"));
          break;
        }
      }
      if (prettyErrors && lineCounter2) {
        doc.errors.forEach(errors.prettifyError(source, lineCounter2));
        doc.warnings.forEach(errors.prettifyError(source, lineCounter2));
      }
      return doc;
    }
    function parse3(src, reviver, options) {
      let _reviver = void 0;
      if (typeof reviver === "function") {
        _reviver = reviver;
      } else if (options === void 0 && reviver && typeof reviver === "object") {
        options = reviver;
      }
      const doc = parseDocument2(src, options);
      if (!doc)
        return null;
      doc.warnings.forEach((warning) => log.warn(doc.options.logLevel, warning));
      if (doc.errors.length > 0) {
        if (doc.options.logLevel !== "silent")
          throw doc.errors[0];
        else
          doc.errors = [];
      }
      return doc.toJS(Object.assign({ reviver: _reviver }, options));
    }
    function stringify(value, replacer, options) {
      let _replacer = null;
      if (typeof replacer === "function" || Array.isArray(replacer)) {
        _replacer = replacer;
      } else if (options === void 0 && replacer) {
        options = replacer;
      }
      if (typeof options === "string")
        options = options.length;
      if (typeof options === "number") {
        const indent = Math.round(options);
        options = indent < 1 ? void 0 : indent > 8 ? { indent: 8 } : { indent };
      }
      if (value === void 0) {
        const { keepUndefined } = options ?? replacer ?? {};
        if (!keepUndefined)
          return void 0;
      }
      if (identity.isDocument(value) && !_replacer)
        return value.toString(options);
      return new Document.Document(value, _replacer, options).toString(options);
    }
    exports2.parse = parse3;
    exports2.parseAllDocuments = parseAllDocuments4;
    exports2.parseDocument = parseDocument2;
    exports2.stringify = stringify;
  }
});

// ../../node_modules/yaml/dist/index.js
var require_dist = __commonJS({
  "../../node_modules/yaml/dist/index.js"(exports2) {
    "use strict";
    var composer = require_composer();
    var Document = require_Document();
    var Schema = require_Schema();
    var errors = require_errors();
    var Alias = require_Alias();
    var identity = require_identity();
    var Pair = require_Pair();
    var Scalar2 = require_Scalar();
    var YAMLMap = require_YAMLMap();
    var YAMLSeq = require_YAMLSeq();
    var cst = require_cst();
    var lexer = require_lexer();
    var lineCounter = require_line_counter();
    var parser = require_parser();
    var publicApi = require_public_api();
    var visit = require_visit();
    exports2.Composer = composer.Composer;
    exports2.Document = Document.Document;
    exports2.Schema = Schema.Schema;
    exports2.YAMLError = errors.YAMLError;
    exports2.YAMLParseError = errors.YAMLParseError;
    exports2.YAMLWarning = errors.YAMLWarning;
    exports2.Alias = Alias.Alias;
    exports2.isAlias = identity.isAlias;
    exports2.isCollection = identity.isCollection;
    exports2.isDocument = identity.isDocument;
    exports2.isMap = identity.isMap;
    exports2.isNode = identity.isNode;
    exports2.isPair = identity.isPair;
    exports2.isScalar = identity.isScalar;
    exports2.isSeq = identity.isSeq;
    exports2.Pair = Pair.Pair;
    exports2.Scalar = Scalar2.Scalar;
    exports2.YAMLMap = YAMLMap.YAMLMap;
    exports2.YAMLSeq = YAMLSeq.YAMLSeq;
    exports2.CST = cst;
    exports2.Lexer = lexer.Lexer;
    exports2.LineCounter = lineCounter.LineCounter;
    exports2.Parser = parser.Parser;
    exports2.parse = publicApi.parse;
    exports2.parseAllDocuments = publicApi.parseAllDocuments;
    exports2.parseDocument = publicApi.parseDocument;
    exports2.stringify = publicApi.stringify;
    exports2.visit = visit.visit;
    exports2.visitAsync = visit.visitAsync;
  }
});

// ../engine/src/envutil/index.ts
var import_node_fs = __toESM(require("node:fs"), 1);
var import_node_path = __toESM(require("node:path"), 1);
var MissingToolPrefix = "\u7F3A\u5C11\u5FC5\u9700\u5DE5\u5177";
var MissingToolError = class extends Error {
  constructor(tool) {
    super(`${MissingToolPrefix}\uFF1A${tool}`);
    this.tool = tool;
  }
  tool;
};
function lookPath(name, pathValue) {
  if (name.includes(import_node_path.default.sep)) return name;
  for (const dir of pathValue.split(import_node_path.default.delimiter)) {
    const candidate2 = import_node_path.default.join(dir || ".", name);
    try {
      const stat = import_node_fs.default.statSync(candidate2);
      if (stat.isFile() && (stat.mode & 73) !== 0) return candidate2;
    } catch {
    }
  }
  throw new MissingToolError(name);
}
function envMap() {
  const out = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== void 0) out[key] = value;
  return out;
}

// ../engine/src/gofmt/index.ts
function formatFixed(value, digits) {
  if (Number.isNaN(value)) return "NaN";
  if (!Number.isFinite(value)) return value > 0 ? "+Inf" : "-Inf";
  const negative = value < 0 || Object.is(value, -0);
  const abs = Math.abs(value);
  let text = abs.toFixed(digits);
  const exact = abs.toFixed(Math.min(100, digits + 60));
  const point = exact.indexOf(".");
  const tail = exact.slice(point + 1 + digits);
  if (/^50*$/.test(tail)) {
    const down = digits === 0 ? exact.slice(0, point) : exact.slice(0, point + 1 + digits);
    if (Number(down[down.length - 1]) % 2 === 0) text = down;
  }
  return negative ? "-" + text : text;
}
function goRound(value) {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}
function formatG(value) {
  if (Number.isNaN(value)) return "NaN";
  if (!Number.isFinite(value)) return value > 0 ? "+Inf" : "-Inf";
  if (value === 0) return Object.is(value, -0) ? "-0" : "0";
  const [mantissa, expText] = value.toExponential().split("e");
  const exp = Number(expText);
  if (exp < -4 || exp >= 6) {
    const digits = String(Math.abs(exp)).padStart(2, "0");
    return `${mantissa}e${exp < 0 ? "-" : "+"}${digits}`;
  }
  return String(value);
}
function goQuote(value) {
  let out = '"';
  for (const ch of value) {
    const c = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "	") out += "\\t";
    else if (ch === "\x07") out += "\\a";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (ch === "\v") out += "\\v";
    else if (c < 32 || c === 127) out += "\\x" + c.toString(16).padStart(2, "0");
    else out += ch;
  }
  return out + '"';
}
function isGoSpace(c) {
  switch (c) {
    case 9:
    case 10:
    case 11:
    case 12:
    case 13:
    case 32:
    case 133:
    case 160:
    case 5760:
    case 8232:
    case 8233:
    case 8239:
    case 8287:
    case 12288:
      return true;
  }
  return c >= 8192 && c <= 8202;
}
function goTrimSpace(s) {
  let start = 0;
  let end = s.length;
  while (start < end && isGoSpace(s.charCodeAt(start))) start++;
  while (end > start && isGoSpace(s.charCodeAt(end - 1))) end--;
  return s.slice(start, end);
}
function goClean(p) {
  if (p === "") return ".";
  const rooted = p.startsWith("/");
  const out = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!rooted) out.push("..");
      continue;
    }
    out.push(part);
  }
  const joined = out.join("/");
  if (rooted) return "/" + joined;
  return joined === "" ? "." : joined;
}
function goJoin(...elems) {
  const parts = elems.filter((e) => e !== "");
  if (parts.length === 0) return "";
  return goClean(parts.join("/"));
}
function goDir(p) {
  const i = p.lastIndexOf("/");
  return goClean(p.slice(0, i + 1));
}
function goExt(p) {
  for (let i = p.length - 1; i >= 0 && p[i] !== "/"; i--) {
    if (p[i] === ".") return p.slice(i);
  }
  return "";
}
var errnoText = {
  ENOENT: "no such file or directory",
  EACCES: "permission denied",
  EPERM: "operation not permitted",
  ENOTDIR: "not a directory",
  EISDIR: "is a directory",
  EEXIST: "file exists",
  ENOTEMPTY: "directory not empty",
  EXDEV: "cross-device link",
  ELOOP: "too many levels of symbolic links",
  ENAMETOOLONG: "file name too long"
};
function goPathError(op, file, err) {
  const code = err?.code;
  const reason = code && errnoText[code] || (err instanceof Error ? err.message : String(err));
  return `${op} ${file}: ${reason}`;
}

// ../engine/src/hyperframes/constants.ts
var SkillsSubdir = ".agents/skills";
var PinnedVersion = "0.8.225";
var SkillsRepoURL = "https://github.com/heygen-com/hyperframes.git";
var PinnedSkillsCommit = "b687d062353f2dd43a9a4b8b77aafeb1077b3875";
var PinnedSkillsCount = 14;
var skillsSubdirsInRepo = ["skills", SkillsSubdir];
var manifestFile = "SKILL.md";

// ../engine/src/hyperframes/hyperframes.ts
var import_node_fs3 = __toESM(require("node:fs"), 1);
var import_node_os = __toESM(require("node:os"), 1);
var import_node_path3 = __toESM(require("node:path"), 1);

// ../engine/src/gojson/index.ts
var hex = "0123456789abcdef";
function encodeString(s, escapeHTML) {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 34) out += '\\"';
    else if (c === 92) out += "\\\\";
    else if (c === 10) out += "\\n";
    else if (c === 13) out += "\\r";
    else if (c === 9) out += "\\t";
    else if (c === 8) out += "\\b";
    else if (c === 12) out += "\\f";
    else if (c < 32 || c === 8232 || c === 8233 || escapeHTML && (c === 60 || c === 62 || c === 38)) {
      out += "\\u" + (c < 256 ? "00" + hex[c >> 4] + hex[c & 15] : c.toString(16));
    } else if (c >= 55296 && c <= 56319) {
      const next = s.charCodeAt(i + 1);
      if (next >= 56320 && next <= 57343) {
        out += s[i] + s[i + 1];
        i++;
      } else out += "\\ufffd";
    } else if (c >= 56320 && c <= 57343) {
      out += "\\ufffd";
    } else out += s[i];
  }
  return out + '"';
}
function encodeNumber(n) {
  if (!Number.isFinite(n)) throw new Error(`json: unsupported value: ${n}`);
  if (Object.is(n, -0)) return "-0";
  return String(n);
}
function encode(value, escapeHTML, indent, prefix) {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return encodeString(value, escapeHTML);
    case "number":
      return encodeNumber(value);
    case "bigint":
      return value.toString();
    case "boolean":
      return value ? "true" : "false";
    case "undefined":
    case "function":
    case "symbol":
      return void 0;
  }
  const v = value;
  if (typeof v.toJSON === "function" && !(value instanceof Date)) return encode(v.toJSON(), escapeHTML, indent, prefix);
  if (value instanceof Date) return encodeString(value.toISOString(), escapeHTML);
  const inner = prefix + indent;
  const nl = indent ? "\n" : "";
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const items2 = value.map((item) => (indent ? inner : "") + (encode(item, escapeHTML, indent, inner) ?? "null"));
    return "[" + nl + items2.join("," + nl) + nl + (indent ? prefix : "") + "]";
  }
  const entries = [];
  for (const [key, item] of Object.entries(value)) {
    const encoded = encode(item, escapeHTML, indent, inner);
    if (encoded === void 0) continue;
    entries.push((indent ? inner : "") + encodeString(key, escapeHTML) + (indent ? ": " : ":") + encoded);
  }
  if (entries.length === 0) return "{}";
  return "{" + nl + entries.join("," + nl) + nl + (indent ? prefix : "") + "}";
}
function marshal(value, options = {}) {
  return encode(value, options.escapeHTML ?? true, options.indent ?? "", "") ?? "null";
}
function marshalIndent(value, indent = "  ", escapeHTML = true) {
  return marshal(value, { indent, escapeHTML });
}
function encodeLine(value, options = {}) {
  return marshal(value, options) + "\n";
}
function sortedKeys(record) {
  const out = {};
  for (const key of Object.keys(record).sort(compareBytes)) out[key] = record[key];
  return out;
}
function compareBytes(a, b) {
  const ca = [...a];
  const cb = [...b];
  const n = Math.min(ca.length, cb.length);
  for (let i = 0; i < n; i++) {
    const x = ca[i].codePointAt(0);
    const y = cb[i].codePointAt(0);
    if (x !== y) return x - y;
  }
  return ca.length - cb.length;
}

// ../engine/src/prereq/index.ts
var SetupCommand = "am setup";
var MissingError = class extends Error {
  /**
   * @param what 资源名，例如「HyperFrames CLI 0.8.225」。
   * @param detail 补充说明（缺在哪里），可以为空。
   */
  constructor(what, detail = "") {
    super(
      `\u7F3A\u5C11\u524D\u7F6E\u8D44\u6E90\uFF1A${what}${detail !== "" ? "\uFF08" + detail + "\uFF09" : ""}\u3002\u5148\u5728\u7EC8\u7AEF\u8FD0\u884C ${SetupCommand} \u51C6\u5907\u597D\uFF08\u53EF\u4EE5\u52A0 --proxy \u8D70\u4EE3\u7406\uFF0C\u65AD\u4E86\u91CD\u8DD1\u4F1A\u63A5\u7740\u4E0B\uFF09\uFF0C\u518D\u91CD\u8BD5`
    );
    this.what = what;
    this.detail = detail;
    this.name = "MissingError";
  }
  what;
  detail;
};
function missing(what, detail) {
  return new MissingError(what, detail);
}

// ../engine/src/hyperframes/manifest.ts
var import_node_crypto = __toESM(require("node:crypto"), 1);
var import_node_fs2 = __toESM(require("node:fs"), 1);
var import_node_path2 = __toESM(require("node:path"), 1);

// ../engine/src/hyperframes/util.ts
var import_node_child_process = require("node:child_process");

// ../engine/src/procgroup/index.ts
var ExitError = class extends Error {
  constructor(code, signal) {
    super(signal ? `signal: ${signal}` : `exit status ${code}`);
    this.code = code;
    this.signal = signal;
    this.name = "ExitError";
  }
  code;
  signal;
  exitCode() {
    return this.code;
  }
};
function abortReason(signal) {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  const err = new Error(reason === void 0 ? "context canceled" : String(reason));
  err.name = "AbortError";
  return err;
}

// ../engine/src/hyperframes/util.ts
function errorText(err) {
  return err instanceof Error ? err.message : String(err);
}
function goQuote2(s) {
  return JSON.stringify(s);
}
function goList(values) {
  return "[" + values.join(" ") + "]";
}
function runCommand(file, args, options = {}) {
  const { signal } = options;
  return new Promise((resolve3, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const child = (0, import_node_child_process.spawn)(file, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", options.stderr ? "pipe" : "ignore"]
    });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (options.stdout) options.stdout.write(chunk);
      else out += chunk;
    });
    if (options.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => options.stderr.write(chunk));
    }
    const onAbort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", onAbort, { once: true });
    let failed = false;
    child.once("error", (err) => {
      failed = true;
      signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code, sig) => {
      signal?.removeEventListener("abort", onAbort);
      if (failed) return;
      if (signal?.aborted) reject(abortReason(signal));
      else if (sig) reject(new ExitError(-1, sig));
      else if (code !== 0) reject(new ExitError(code ?? -1, null));
      else resolve3(out);
    });
  });
}

// ../engine/src/hyperframes/manifest.ts
var ManifestFile = "hyperframes-upstream.json";
var ManifestSchema = "hyperframes-upstream/v1";
function walkFiles(root, rel = "", out = []) {
  const dir = rel === "" ? root : import_node_path2.default.join(root, rel);
  const entries = import_node_fs2.default.readdirSync(dir, { withFileTypes: true }).sort((a, b) => compareBytes(a.name, b.name));
  for (const entry of entries) {
    const child = rel === "" ? entry.name : import_node_path2.default.join(rel, entry.name);
    if (entry.isDirectory()) walkFiles(root, child, out);
    else out.push(child);
  }
  return out;
}
function skillDigest(dir) {
  let paths;
  try {
    paths = walkFiles(dir).map((rel) => rel.split(import_node_path2.default.sep).join("/"));
  } catch (err) {
    throw new Error(`\u904D\u5386\u6280\u80FD\u76EE\u5F55 ${dir} \u5931\u8D25\uFF1A${errorText(err)}`, { cause: err });
  }
  paths.sort(compareBytes);
  const sum = import_node_crypto.default.createHash("sha256");
  for (const rel of paths) {
    sum.update(rel + "\0", "utf8");
    let body;
    try {
      body = import_node_fs2.default.readFileSync(import_node_path2.default.join(dir, ...rel.split("/")));
    } catch (err) {
      throw new Error(`\u8BFB\u53D6 ${rel} \u5931\u8D25\uFF1A${errorText(err)}`, { cause: err });
    }
    sum.update(body);
    sum.update("\0", "utf8");
  }
  return sum.digest("hex");
}
function writeManifest(projectDir, cliVersion, commit, installed2) {
  const skillsDir = import_node_path2.default.join(projectDir, SkillsSubdir);
  const skills = {};
  for (const name of installed2) skills[name] = skillDigest(import_node_path2.default.join(skillsDir, name));
  const body = marshalIndent({ schema: ManifestSchema, cliVersion, upstreamCommit: commit, skills: sortedKeys(skills) });
  try {
    import_node_fs2.default.writeFileSync(import_node_path2.default.join(skillsDir, ManifestFile), body + "\n", { mode: 420 });
  } catch (err) {
    throw new Error(`\u5199\u5165 ${ManifestFile} \u5931\u8D25\uFF1A${errorText(err)}`, { cause: err });
  }
}

// ../engine/src/hyperframes/progress.ts
var cloneStages = [
  { prefix: "remote: Counting objects", label: "\u8FDE\u63A5\u4E0A\u6E38\u4ED3\u5E93", from: 0, to: 4 },
  { prefix: "remote: Compressing objects", label: "\u8FDE\u63A5\u4E0A\u6E38\u4ED3\u5E93", from: 4, to: 8 },
  { prefix: "Receiving objects", label: "\u4E0B\u8F7D\u6280\u80FD\u4ED3\u5E93", from: 8, to: 62 },
  { prefix: "Resolving deltas", label: "\u6574\u7406\u4E0B\u8F7D\u5185\u5BB9", from: 62, to: 68 },
  { prefix: "Updating files", label: "\u6574\u7406\u4E0B\u8F7D\u5185\u5BB9", from: 68, to: 72 }
];
var checkoutStart = 72;
var copyStart = 95;
var percentPattern = /(\d{1,3})%/;
var GitProgress = class {
  constructor(report, next) {
    this.report = report;
    this.next = next;
  }
  report;
  next;
  buf = "";
  last = 0;
  write(chunk) {
    this.next?.write(chunk);
    this.buf += chunk;
    for (; ; ) {
      const i = this.buf.search(/[\r\n]/);
      if (i < 0) break;
      this.line(this.buf.slice(0, i));
      this.buf = this.buf.slice(i + 1);
    }
    return chunk.length;
  }
  line(line2) {
    for (const stage of cloneStages) {
      if (!line2.startsWith(stage.prefix)) continue;
      const match = percentPattern.exec(line2);
      if (!match) return;
      const percent = Number.parseInt(match[1], 10);
      const overall = stage.from + (stage.to - stage.from) * Math.min(percent, 100) / 100;
      if (overall < this.last) return;
      this.last = overall;
      this.report({ stage: stage.label, percent: overall });
      return;
    }
  }
};

// ../engine/src/hyperframes/hyperframes.ts
function resolve(opts, defaultVersion) {
  return {
    ...opts,
    version: opts.version || defaultVersion,
    repoURL: opts.repoURL || SkillsRepoURL,
    expectCommit: opts.expectCommit || PinnedSkillsCommit,
    expectSkills: opts.expectSkills || PinnedSkillsCount,
    env: opts.env ?? {}
  };
}
function defaultCacheDir(env) {
  if (env.XDG_DATA_HOME) return import_node_path3.default.join(env.XDG_DATA_HOME, "am", "hyperframes");
  if (env.HOME) return import_node_path3.default.join(env.HOME, ".local", "share", "am", "hyperframes");
  return "";
}
function skillsReady(cacheDir) {
  return cachedTree(cacheDir, PinnedSkillsCommit, PinnedSkillsCount) !== "";
}
function exists(file) {
  try {
    import_node_fs3.default.statSync(file);
    return true;
  } catch {
    return false;
  }
}
async function prepareSkills(options, signal) {
  const opts = resolve(options, PinnedVersion);
  if (!opts.cacheDir) throw new Error("\u65E0\u6CD5\u786E\u5B9A HyperFrames \u6280\u80FD\u7684\u7F13\u5B58\u76EE\u5F55\uFF1A\u73AF\u5883\u91CC\u6CA1\u6709 HOME");
  if (cachedTree(opts.cacheDir, opts.expectCommit, opts.expectSkills) !== "") return;
  const report = opts.progress ?? (() => {
  });
  let git;
  try {
    git = lookPath("git", opts.env.PATH ?? "");
  } catch (err) {
    throw new Error(`\u627E\u4E0D\u5230 git\uFF0C\u65E0\u6CD5\u4E0B\u8F7D HyperFrames \u6280\u80FD\uFF1A${errorText(err)}`, { cause: err });
  }
  const tmp = makeTemp();
  try {
    report({ stage: "\u8FDE\u63A5\u4E0A\u6E38\u4ED3\u5E93", percent: 0 });
    const commit = await cloneSkills(git, tmp, opts, report, signal);
    report({ stage: "\u5B58\u8FDB\u672C\u673A\u7F13\u5B58", percent: copyStart });
    try {
      storeCache(opts.cacheDir, commit, tmp);
    } catch (err) {
      throw new Error(`\u5B58\u8FDB\u672C\u673A\u7F13\u5B58\uFF1A${errorText(err)}`, { cause: err });
    }
    if (cachedTree(opts.cacheDir, opts.expectCommit, opts.expectSkills) === "") {
      import_node_fs3.default.rmSync(import_node_path3.default.join(opts.cacheDir, commit), { recursive: true, force: true });
      throw new Error(
        `\u4E0A\u6E38 ${commit} \u62FC\u88C5\u51FA\u7684\u6280\u80FD\u6570\u4E0D\u662F ${opts.expectSkills}\uFF1A\u6280\u80FD\u76EE\u5F55\u7ED3\u6784\u53EF\u80FD\u5DF2\u53D8\uFF0C\u6838\u5BF9 ${goList(skillsSubdirsInRepo)} \u4E24\u5904\u540E\u540C\u6B65 PinnedSkillsCount`
      );
    }
    report({ stage: "\u5B8C\u6210", percent: 100 });
  } finally {
    import_node_fs3.default.rmSync(tmp, { recursive: true, force: true });
  }
}
function makeTemp() {
  try {
    return import_node_fs3.default.mkdtempSync(import_node_path3.default.join(import_node_os.default.tmpdir(), "am-hyperframes-"));
  } catch (err) {
    throw new Error(`\u65E0\u6CD5\u521B\u5EFA\u4E34\u65F6\u76EE\u5F55\uFF1A${errorText(err)}`, { cause: err });
  }
}
var cacheMarker = ".am-commit";
function cachedTree(cacheRoot, commit, expectSkills) {
  if (!cacheRoot || commit === "" || commit === "-") return "";
  const dir = import_node_path3.default.join(cacheRoot, commit);
  let body;
  try {
    body = import_node_fs3.default.readFileSync(import_node_path3.default.join(dir, cacheMarker), "utf8");
  } catch {
    return "";
  }
  if (body.trim() !== commit) return "";
  let count = 0;
  for (const sub of skillsSubdirsInRepo) {
    let entries;
    try {
      entries = import_node_fs3.default.readdirSync(import_node_path3.default.join(dir, sub));
    } catch {
      continue;
    }
    for (const name of entries) if (exists(import_node_path3.default.join(dir, sub, name, manifestFile))) count++;
  }
  return count === expectSkills ? dir : "";
}
function storeCache(cacheRoot, commit, clone3) {
  if (!cacheRoot || commit === "") return;
  import_node_fs3.default.mkdirSync(cacheRoot, { recursive: true });
  const staging = import_node_fs3.default.mkdtempSync(import_node_path3.default.join(cacheRoot, ".staging-"));
  try {
    for (const sub of skillsSubdirsInRepo) {
      const source = import_node_path3.default.join(clone3, sub);
      if (!exists(source)) continue;
      copyTree(source, import_node_path3.default.join(staging, sub));
    }
    import_node_fs3.default.writeFileSync(import_node_path3.default.join(staging, cacheMarker), commit + "\n", { mode: 420 });
    const target = import_node_path3.default.join(cacheRoot, commit);
    import_node_fs3.default.rmSync(target, { recursive: true, force: true });
    try {
      import_node_fs3.default.renameSync(staging, target);
    } catch (err) {
      if (exists(import_node_path3.default.join(target, cacheMarker))) return;
      throw err;
    }
  } finally {
    import_node_fs3.default.rmSync(staging, { recursive: true, force: true });
  }
}
async function install(options, signal) {
  if (!options.version) throw new Error("\u5FC5\u987B\u6307\u5B9A HyperFrames \u7248\u672C");
  const opts = resolve(options, options.version);
  const report = opts.progress ?? (() => {
  });
  let tmp;
  let commit;
  let cleanup;
  let git = "";
  const cached = cachedTree(opts.cacheDir, opts.expectCommit, opts.expectSkills);
  if (cached !== "") {
    tmp = cached;
    commit = opts.expectCommit;
    report({ stage: "\u4ECE\u672C\u673A\u7F13\u5B58\u8BFB\u53D6", percent: checkoutStart });
  } else if (opts.cacheOnly) {
    throw missing("HyperFrames " + opts.version + " \u6280\u80FD", "\u672C\u673A\u7F13\u5B58\u91CC\u6CA1\u6709");
  } else {
    try {
      git = lookPath("git", opts.env.PATH ?? "");
    } catch (err) {
      throw new Error(`\u627E\u4E0D\u5230 git\uFF0C\u65E0\u6CD5\u83B7\u53D6 HyperFrames \u6280\u80FD\uFF1A${errorText(err)}`, { cause: err });
    }
    tmp = makeTemp();
    cleanup = tmp;
  }
  try {
    if (cleanup) {
      report({ stage: "\u8FDE\u63A5\u4E0A\u6E38\u4ED3\u5E93", percent: 0 });
      commit = await cloneSkills(git, tmp, opts, report, signal);
      try {
        storeCache(opts.cacheDir, commit, tmp);
      } catch (err) {
        opts.output?.write(`\u8B66\u544A\uFF1AHyperFrames \u6280\u80FD\u6CA1\u80FD\u5B58\u8FDB\u672C\u673A\u7F13\u5B58\uFF08${errorText(err)}\uFF09\uFF0C\u4E0B\u6B21\u5B89\u88C5\u4ECD\u4F1A\u8054\u7F51
`);
      }
    }
    const sources2 = [];
    for (const sub of skillsSubdirsInRepo) {
      const p = import_node_path3.default.join(tmp, sub);
      if (exists(p)) sources2.push(p);
    }
    if (sources2.length === 0) {
      throw new Error(`\u4E0A\u6E38\u4ED3\u5E93 ${opts.repoURL} \u5728 ${commit} \u4E0A\u6CA1\u6709 ${goList(skillsSubdirsInRepo)} \u4E2D\u7684\u4EFB\u4F55\u4E00\u5904\uFF0C\u6280\u80FD\u76EE\u5F55\u7ED3\u6784\u5DF2\u53D8`);
    }
    report({ stage: "\u62F7\u8FDB\u9879\u76EE", percent: copyStart });
    const result = copySkills(sources2, import_node_path3.default.join(opts.projectDir ?? "", SkillsSubdir), opts.protectedSkills, (done) => {
      report({ stage: "\u62F7\u8FDB\u9879\u76EE", percent: copyStart + 5 * done / Math.max(opts.expectSkills, done) });
    });
    const total = result.installed.length + result.protected.length;
    if (total !== opts.expectSkills) {
      throw new Error(
        `\u4E0A\u6E38 ${commit} \u62FC\u88C5\u51FA ${total} \u4E2A\u6280\u80FD\uFF0C\u671F\u671B ${opts.expectSkills} \u4E2A\uFF1A\u6280\u80FD\u76EE\u5F55\u7ED3\u6784\u53EF\u80FD\u5DF2\u53D8\uFF0C\u6838\u5BF9 ${goList(skillsSubdirsInRepo)} \u4E24\u5904\u540E\u540C\u6B65 PinnedSkillsCount`
      );
    }
    writeManifest(opts.projectDir ?? "", opts.version, commit, result.installed);
    report({ stage: "\u5B8C\u6210", percent: 100 });
    return result;
  } finally {
    if (cleanup) import_node_fs3.default.rmSync(cleanup, { recursive: true, force: true });
  }
}
async function cloneSkills(git, dir, opts, report, signal) {
  const env = cloneEnv(opts.env);
  const run2 = async (stderr, args) => (await runCommand(git, args, { cwd: dir, env, stderr, signal })).trim();
  const tag = "v" + opts.version;
  let verbosity = "--quiet";
  let cloneErr = opts.output;
  if (opts.progress) {
    verbosity = "--progress";
    cloneErr = new GitProgress(report, opts.output);
  }
  try {
    await run2(cloneErr, [
      "-c",
      "advice.detachedHead=false",
      "clone",
      verbosity,
      "--depth",
      "1",
      "--filter=blob:none",
      "--sparse",
      "--branch",
      tag,
      opts.repoURL,
      "."
    ]);
  } catch (err) {
    throw new Error(`\u514B\u9686 ${opts.repoURL} \u7684 ${tag} \u5931\u8D25\uFF1A${errorText(err)}`, { cause: err });
  }
  report({ stage: "\u4E0B\u8F7D\u6280\u80FD\u6587\u4EF6", percent: checkoutStart, indeterminate: true });
  try {
    await run2(opts.output, ["sparse-checkout", "set", ...skillsSubdirsInRepo]);
  } catch (err) {
    throw new Error(`\u68C0\u51FA\u6280\u80FD\u76EE\u5F55\u5931\u8D25\uFF1A${errorText(err)}`, { cause: err });
  }
  let commit;
  try {
    commit = await run2(opts.output, ["rev-parse", "HEAD"]);
  } catch (err) {
    throw new Error(`\u65E0\u6CD5\u89E3\u6790 ${tag} \u6307\u5411\u7684 commit\uFF1A${errorText(err)}`, { cause: err });
  }
  if (opts.expectCommit !== "-" && commit !== opts.expectCommit) {
    throw new Error(`${tag} \u6307\u5411 ${commit}\uFF0C\u4E0E\u56FA\u5B9A\u7684 ${opts.expectCommit} \u4E0D\u7B26\uFF1Atag \u88AB\u79FB\u52A8\u8FC7\uFF0C\u62D2\u7EDD\u5B89\u88C5`);
  }
  return commit;
}
function cloneEnv(env) {
  return {
    ...env,
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0"
  };
}
function readDirSorted(dir) {
  return import_node_fs3.default.readdirSync(dir, { withFileTypes: true }).sort((a, b) => compareBytes(a.name, b.name));
}
function copySkills(sources2, dest, protectedSkills, copied) {
  import_node_fs3.default.mkdirSync(dest, { recursive: true });
  const result = { installed: [], protected: [] };
  const seen = /* @__PURE__ */ new Map();
  for (const source of sources2) {
    let entries;
    try {
      entries = readDirSorted(source);
    } catch (err) {
      throw new Error(`\u65E0\u6CD5\u8BFB\u53D6\u5B89\u88C5\u4EA7\u7269\uFF1A${errorText(err)}`, { cause: err });
    }
    for (const entry of entries) {
      const name = entry.name;
      if (!entry.isDirectory()) continue;
      if (!exists(import_node_path3.default.join(source, name, manifestFile))) continue;
      const previous = seen.get(name);
      if (previous !== void 0) throw new Error(`\u6280\u80FD ${name} \u5728 ${previous} \u4E0E ${source} \u4E24\u5904\u91CD\u590D\uFF0C\u65E0\u6CD5\u786E\u5B9A\u7528\u54EA\u4E00\u4EFD`);
      seen.set(name, source);
      if (protectedSkills?.has(name)) {
        result.protected.push(name);
        continue;
      }
      const target = import_node_path3.default.join(dest, name);
      import_node_fs3.default.rmSync(target, { recursive: true, force: true });
      try {
        copyTree(import_node_path3.default.join(source, name), target);
      } catch (err) {
        throw new Error(`\u62F7\u8D1D\u6280\u80FD ${name} \u5931\u8D25\uFF1A${errorText(err)}`, { cause: err });
      }
      result.installed.push(name);
      copied?.(result.installed.length + result.protected.length);
    }
  }
  if (result.installed.length === 0) throw new Error(`\u5B89\u88C5\u4EA7\u7269\u91CC\u6CA1\u6709\u4EFB\u4F55\u6280\u80FD\u76EE\u5F55\uFF1A${goList(sources2)}`);
  result.installed.sort(compareBytes);
  result.protected.sort(compareBytes);
  return result;
}
function copyTree(source, dest) {
  const walk = (relative) => {
    const from = relative === "" ? source : import_node_path3.default.join(source, relative);
    const target = relative === "" ? dest : import_node_path3.default.join(dest, relative);
    import_node_fs3.default.mkdirSync(target, { recursive: true, mode: 493 });
    for (const entry of readDirSorted(from)) {
      const rel = relative === "" ? entry.name : import_node_path3.default.join(relative, entry.name);
      if (entry.isDirectory()) {
        walk(rel);
      } else if (entry.isSymbolicLink()) {
        throw new Error(`\u5B89\u88C5\u4EA7\u7269\u542B\u7B26\u53F7\u94FE\u63A5\uFF0C\u65E0\u6CD5\u5B89\u5168\u642C\u8FDB\u9879\u76EE\uFF1A${rel}`);
      } else if (entry.isFile()) {
        const file = import_node_path3.default.join(source, rel);
        const mode = import_node_fs3.default.statSync(file).mode & 511;
        const body = import_node_fs3.default.readFileSync(file);
        import_node_fs3.default.mkdirSync(import_node_path3.default.dirname(import_node_path3.default.join(dest, rel)), { recursive: true, mode: 493 });
        import_node_fs3.default.writeFileSync(import_node_path3.default.join(dest, rel), body, { mode });
      }
    }
  };
  walk("");
}

// ../engine/src/hyperframes/cli.ts
var import_node_fs4 = __toESM(require("node:fs"), 1);
var import_node_path4 = __toESM(require("node:path"), 1);
var import_promises = require("node:timers/promises");
var CLIDirEnv = "AM_HYPERFRAMES_CLI_DIR";
var cliMarker = ".am-cli";
function cliDir(env, version) {
  const dir = env[CLIDirEnv];
  if (dir) return dir;
  const root = defaultCacheDir(env);
  if (root === "") return "";
  return import_node_path4.default.join(root, "cli-" + version);
}
function cliBinary(dir) {
  return import_node_path4.default.join(dir, "node_modules", ".bin", "hyperframes");
}
function cliReady(dir, version) {
  if (dir === "") return false;
  try {
    if (import_node_fs4.default.readFileSync(import_node_path4.default.join(dir, cliMarker), "utf8").trim() !== version) return false;
    return !import_node_fs4.default.statSync(cliBinary(dir)).isDirectory();
  } catch {
    return false;
  }
}
function requireCLI(env) {
  const dir = cliDir(env, PinnedVersion);
  if (cliReady(dir, PinnedVersion)) return dir;
  if (dir === "") throw missing("HyperFrames CLI " + PinnedVersion, "\u73AF\u5883\u91CC\u6CA1\u6709 HOME\uFF0C\u4E5F\u6CA1\u6709 " + CLIDirEnv);
  throw missing("HyperFrames CLI " + PinnedVersion, "\u6CA1\u6709\u88C5\u5728 " + dir);
}
var cliAttempts = 3;
async function ensureCLI(opts, signal) {
  const version = opts.version || PinnedVersion;
  const env = opts.env ?? {};
  const dir = cliDir(env, version);
  if (dir === "") throw new Error(`\u65E0\u6CD5\u786E\u5B9A HyperFrames CLI \u7684\u5B89\u88C5\u76EE\u5F55\uFF1A\u73AF\u5883\u91CC\u6CA1\u6709 HOME\uFF0C\u53EF\u7528 ${CLIDirEnv} \u6307\u5B9A`);
  if (cliReady(dir, version)) return dir;
  const report = opts.progress ?? (() => {
  });
  let npm;
  try {
    npm = lookPath("npm", env.PATH ?? "");
  } catch (err) {
    throw new Error(`\u627E\u4E0D\u5230 npm\uFF08\u9700\u8981 Node 20+\uFF09\uFF0C\u65E0\u6CD5\u5B89\u88C5 HyperFrames CLI\uFF1A${errorText(err)}`, { cause: err });
  }
  import_node_fs4.default.mkdirSync(import_node_path4.default.dirname(dir), { recursive: true });
  const unlock = await lockFile(dir + ".lock", signal);
  try {
    if (cliReady(dir, version)) return dir;
    const pkg = opts.package || "hyperframes@" + version;
    let lastErr;
    for (let attempt = 1; attempt <= cliAttempts; attempt++) {
      let stage = "\u5B89\u88C5 HyperFrames CLI " + version;
      if (attempt > 1) stage = `\u5B89\u88C5 HyperFrames CLI ${version}\uFF08\u91CD\u8BD5 ${attempt}/${cliAttempts}\uFF09`;
      report({ stage, percent: 0, indeterminate: true });
      try {
        await installCLI(npm, dir, pkg, version, env, opts.output, signal);
        report({ stage: "HyperFrames CLI \u5DF2\u5C31\u7EEA", percent: 100 });
        return dir;
      } catch (err) {
        lastErr = err;
      }
      if (signal?.aborted) throw abortReason(signal);
      if (opts.output && attempt < cliAttempts) {
        opts.output.write(`\u5B89\u88C5 HyperFrames CLI \u5931\u8D25\uFF0C\u91CD\u8BD5\uFF08${attempt + 1}/${cliAttempts}\uFF09\uFF1A${errorText(lastErr)}
`);
      }
    }
    throw new Error(`\u5B89\u88C5 HyperFrames CLI ${version} \u5931\u8D25\uFF08npm \u7528\u7684\u662F\u4F60\u7684 ~/.npmrc\uFF1B\u7F51\u7EDC\u597D\u8F6C\u540E\u91CD\u65B0\u8FD0\u884C\u5373\u53EF\uFF09\uFF1A${errorText(lastErr)}`, {
      cause: lastErr
    });
  } finally {
    unlock();
  }
}
async function installCLI(npm, dir, pkg, version, env, output2, signal) {
  const staging = import_node_fs4.default.mkdtempSync(import_node_path4.default.join(import_node_path4.default.dirname(dir), ".cli-"));
  try {
    import_node_fs4.default.writeFileSync(import_node_path4.default.join(staging, "package.json"), '{"private":true}\n', { mode: 420 });
    const sink = output2 ?? { write: () => true };
    try {
      await runCommand(npm, ["install", "--no-audit", "--no-fund", "--loglevel=error", "--save-exact", pkg], {
        cwd: staging,
        env,
        stdout: sink,
        stderr: sink,
        signal
      });
    } catch (err) {
      throw new Error(`npm install ${pkg}\uFF1A${errorText(err)}`, { cause: err });
    }
    const binary = cliBinary(staging);
    if (!import_node_fs4.default.existsSync(binary)) throw new Error(`npm \u88C5\u5B8C\u4E86\u4F46\u6CA1\u6709 ${import_node_path4.default.basename(binary)}\uFF1A\u5305\u7ED3\u6784\u5DF2\u53D8`);
    let out;
    try {
      out = await runCommand(binary, ["--version"], { cwd: staging, env, signal });
    } catch (err) {
      throw new Error(`\u88C5\u597D\u7684 HyperFrames CLI \u8DD1\u4E0D\u8D77\u6765\uFF1A${errorText(err)}`, { cause: err });
    }
    const got = out.trim();
    if (!got.includes(version)) throw new Error(`\u88C5\u597D\u7684 HyperFrames CLI \u62A5\u544A\u7248\u672C ${goQuote2(got)}\uFF0C\u671F\u671B ${version}`);
    import_node_fs4.default.writeFileSync(import_node_path4.default.join(staging, cliMarker), version + "\n", { mode: 420 });
    import_node_fs4.default.rmSync(dir, { recursive: true, force: true });
    import_node_fs4.default.renameSync(staging, dir);
  } finally {
    import_node_fs4.default.rmSync(staging, { recursive: true, force: true });
  }
}
function cliCommandFor(dir, env, args) {
  return { file: cliBinary(dir), args: [...args], env: { ...env } };
}
var lockStale = 30 * 60 * 1e3;
async function lockFile(file, signal) {
  for (; ; ) {
    try {
      const fd = import_node_fs4.default.openSync(file, "wx", 420);
      import_node_fs4.default.writeSync(fd, `${process.pid}
`);
      import_node_fs4.default.closeSync(fd);
      return () => import_node_fs4.default.rmSync(file, { force: true });
    } catch (err) {
      if (err.code !== "EEXIST") {
        throw new Error(`\u521B\u5EFA\u9501 ${file}\uFF1A${errorText(err)}`, { cause: err });
      }
    }
    try {
      if (Date.now() - import_node_fs4.default.statSync(file).mtimeMs > lockStale) {
        import_node_fs4.default.rmSync(file, { force: true });
        continue;
      }
    } catch {
    }
    if (signal?.aborted) throw abortReason(signal);
    try {
      await (0, import_promises.setTimeout)(500, void 0, { signal });
    } catch {
      throw abortReason(signal);
    }
  }
}

// src/cobra.ts
var ExitError2 = class extends Error {
  constructor(code, message = "") {
    super(message + "\uFF08\u9000\u51FA\u7801 " + code + "\uFF09");
    this.code = code;
    this.bare = message;
  }
  code;
  /** 不带退出码后缀的原始消息。 */
  bare;
};
var ref = (value) => ({ value });
var FlagError = class extends Error {
};
var Microsecond = 1e3;
var Millisecond = 1e6;
var Second = 1e9;
var Minute = 60 * Second;
var Hour = 60 * Minute;
var unitMap = { ns: 1, us: 1e3, \u00B5s: 1e3, \u03BCs: 1e3, ms: 1e6, s: 1e9, m: 6e10, h: 36e11 };
function parseDuration(s) {
  const orig = s;
  let d = 0;
  let neg = false;
  if (s && (s[0] === "-" || s[0] === "+")) {
    neg = s[0] === "-";
    s = s.slice(1);
  }
  if (s === "0") return 0;
  if (s === "") throw new Error(`time: invalid duration ${JSON.stringify(orig)}`);
  while (s !== "") {
    const m = /^(\d*)(?:\.(\d*))?/.exec(s);
    if (!m[1] && !m[2]) throw new Error(`time: invalid duration ${JSON.stringify(orig)}`);
    s = s.slice(m[0].length);
    const u = /^[^\d.]+/.exec(s)?.[0] ?? "";
    if (!u) throw new Error(`time: missing unit in duration ${JSON.stringify(orig)}`);
    const unit = unitMap[u];
    if (unit === void 0) throw new Error(`time: unknown unit ${JSON.stringify(u)} in duration ${JSON.stringify(orig)}`);
    s = s.slice(u.length);
    d += Number(m[1] || "0") * unit + (m[2] ? Number("0." + m[2]) * unit : 0);
  }
  return Math.round(neg ? -d : d);
}
function formatDuration(d) {
  if (d === 0) return "0s";
  const neg = d < 0;
  let u = Math.abs(d);
  let out;
  if (u < Second) {
    const [unit, size] = u < Microsecond ? ["ns", 1] : u < Millisecond ? ["\xB5s", Microsecond] : ["ms", Millisecond];
    out = trimFloat(u / size) + unit;
  } else {
    const h = Math.floor(u / Hour);
    u -= h * Hour;
    const m = Math.floor(u / Minute);
    u -= m * Minute;
    const sec = trimFloat(u / Second) + "s";
    out = h > 0 ? `${h}h${m}m${sec}` : m > 0 ? `${m}m${sec}` : sec;
  }
  return neg ? "-" + out : out;
}
function trimFloat(n) {
  return String(Number(n.toFixed(9)));
}
function goQuote3(s) {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "	") out += "\\t";
    else if (ch === "\r") out += "\\r";
    else if (c < 32 || c === 127) out += "\\x" + c.toString(16).padStart(2, "0");
    else out += ch;
  }
  return out + '"';
}
function parseGoInt(raw) {
  const s = raw.replace(/_/g, "");
  const m = /^([+-])?(0[xX][0-9a-fA-F]+|0[oO]?[0-7]+|0[bB][01]+|[0-9]+)$/.exec(s);
  if (!m) throw new Error(`strconv.ParseInt: parsing ${goQuote3(raw)}: invalid syntax`);
  let body = m[2];
  let value;
  if (/^0[xX]/.test(body)) value = parseInt(body.slice(2), 16);
  else if (/^0[bB]/.test(body)) value = parseInt(body.slice(2), 2);
  else if (/^0[oO]/.test(body)) value = parseInt(body.slice(2), 8);
  else if (body.length > 1 && body.startsWith("0")) value = parseInt(body.slice(1), 8);
  else value = parseInt(body = body, 10);
  return m[1] === "-" ? -value : value;
}
function parseGoFloat(raw) {
  const s = raw.trim() === raw ? raw : "";
  if (/^[+-]?(inf|infinity)$/i.test(s)) return s.startsWith("-") ? -Infinity : Infinity;
  if (/^nan$/i.test(s)) return NaN;
  if (/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(s)) return Number(s);
  throw new Error(`strconv.ParseFloat: parsing ${goQuote3(raw)}: invalid syntax`);
}
function parseGoBool(raw) {
  if (["1", "t", "T", "TRUE", "true", "True"].includes(raw)) return true;
  if (["0", "f", "F", "FALSE", "false", "False"].includes(raw)) return false;
  throw new Error(`strconv.ParseBool: parsing ${goQuote3(raw)}: invalid syntax`);
}
function readCSV(value) {
  if (value === "") return [];
  const out = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (quoted) {
      if (ch === '"' && value[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === ",") {
      out.push(field);
      field = "";
    } else field += ch;
  }
  out.push(field);
  return out;
}
var FlagSet = class {
  formal = /* @__PURE__ */ new Map();
  shorthands = /* @__PURE__ */ new Map();
  add(flag) {
    if (this.formal.has(flag.name)) throw new Error(`flag redefined: ${flag.name}`);
    const full = { changed: false, noOptDefVal: "", hidden: false, ...flag };
    this.formal.set(flag.name, full);
    if (flag.shorthand) this.shorthands.set(flag.shorthand, full);
  }
  addFlag(flag) {
    if (this.formal.has(flag.name)) return;
    this.formal.set(flag.name, flag);
    if (flag.shorthand) this.shorthands.set(flag.shorthand, flag);
  }
  stringVar(target, name, def, usage, shorthand = "") {
    target.value = def;
    this.add({ name, shorthand, usage, type: "string", defValue: def, set: (v) => target.value = v });
  }
  boolVar(target, name, def, usage, shorthand = "") {
    target.value = def;
    this.add({ name, shorthand, usage, type: "bool", defValue: String(def), set: (v) => target.value = parseGoBool(v), noOptDefVal: "true" });
  }
  intVar(target, name, def, usage, shorthand = "") {
    target.value = def;
    this.add({ name, shorthand, usage, type: "int", defValue: String(def), set: (v) => target.value = parseGoInt(v) });
  }
  float64Var(target, name, def, usage, shorthand = "") {
    target.value = def;
    this.add({ name, shorthand, usage, type: "float64", defValue: formatG(def), set: (v) => target.value = parseGoFloat(v) });
  }
  durationVar(target, name, def, usage, shorthand = "") {
    target.value = def;
    this.add({ name, shorthand, usage, type: "duration", defValue: formatDuration(def), set: (v) => target.value = parseDuration(v) });
  }
  /** StringArrayVar：每次出现追加一项，不按逗号拆。第一次出现时先清掉默认值。 */
  stringArrayVar(target, name, def, usage, shorthand = "") {
    target.value = [...def];
    let fresh = true;
    this.add({
      name,
      shorthand,
      usage,
      type: "stringArray",
      defValue: "[" + def.join(",") + "]",
      set: (v) => {
        target.value = fresh ? [v] : [...target.value, v];
        fresh = false;
      }
    });
  }
  /** StringSliceVar：每次出现按 CSV 拆开追加。第一次出现时先清掉默认值。 */
  stringSliceVar(target, name, def, usage, shorthand = "") {
    target.value = [...def];
    let fresh = true;
    this.add({
      name,
      shorthand,
      usage,
      type: "stringSlice",
      defValue: "[" + def.join(",") + "]",
      set: (v) => {
        const parts = readCSV(v);
        target.value = fresh ? parts : [...target.value, ...parts];
        fresh = false;
      }
    });
  }
  lookup(name) {
    return this.formal.get(name);
  }
  changed(name) {
    return this.formal.get(name)?.changed ?? false;
  }
  shorthandLookup(short) {
    return this.shorthands.get(short);
  }
  sorted() {
    return [...this.formal.values()].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  }
  hasAvailable() {
    return [...this.formal.values()].some((f) => !f.hidden);
  }
  /** pflag FlagSet.FlagUsages（不折行）。 */
  usages() {
    const lines = [];
    let maxlen = 0;
    for (const flag of this.sorted()) {
      if (flag.hidden) continue;
      let line2 = flag.shorthand ? `  -${flag.shorthand}, --${flag.name}` : `      --${flag.name}`;
      const [varname, usage] = unquoteUsage(flag);
      if (varname) line2 += " " + varname;
      if (flag.noOptDefVal && !(flag.type === "bool" && flag.noOptDefVal === "true")) {
        line2 += flag.type === "string" ? `[="${flag.noOptDefVal}"]` : `[=${flag.noOptDefVal}]`;
      }
      line2 += "\0";
      if (Buffer.byteLength(line2) > maxlen) maxlen = Buffer.byteLength(line2);
      line2 += usage;
      if (!defaultIsZero(flag)) line2 += flag.type === "string" ? ` (default ${goQuote3(flag.defValue)})` : ` (default ${flag.defValue})`;
      lines.push(line2);
    }
    let out = "";
    for (const line2 of lines) {
      const sidx = line2.indexOf("\0");
      const left = line2.slice(0, sidx);
      const spacing = " ".repeat(maxlen - Buffer.byteLength(line2.slice(0, sidx)));
      const rest = line2.slice(sidx + 1).replace(/\n/g, "\n" + " ".repeat(maxlen + 2));
      out += `${left} ${spacing} ${rest}
`;
    }
    return out;
  }
};
function unquoteUsage(flag) {
  const usage = flag.usage;
  const i = usage.indexOf("`");
  if (i >= 0) {
    const j = usage.indexOf("`", i + 1);
    if (j >= 0) {
      const name = usage.slice(i + 1, j);
      return [name, usage.slice(0, i) + name + usage.slice(j + 1)];
    }
  }
  const names = { string: "string", bool: "", int: "int", float64: "float", stringArray: "stringArray", stringSlice: "strings", duration: "duration" };
  return [names[flag.type], usage];
}
function defaultIsZero(flag) {
  switch (flag.type) {
    case "bool":
      return flag.defValue === "false" || flag.defValue === "";
    case "duration":
      return flag.defValue === "0" || flag.defValue === "0s";
    case "int":
    case "float64":
      return flag.defValue === "0";
    case "string":
      return flag.defValue === "";
    case "stringArray":
    case "stringSlice":
      return flag.defValue === "[]";
  }
}
var minNamePadding = 11;
var Command = class _Command {
  use;
  short;
  long;
  example;
  aliases;
  version;
  hidden;
  disableFlagParsing;
  args;
  runE;
  parent;
  children = [];
  local = new FlagSet();
  persistent = new FlagSet();
  out;
  err;
  signal;
  constructor(options) {
    this.use = options.use;
    this.short = options.short ?? "";
    this.long = options.long ?? "";
    this.example = options.example ?? "";
    this.aliases = options.aliases ?? [];
    this.version = options.version ?? "";
    this.hidden = options.hidden ?? false;
    this.disableFlagParsing = options.disableFlagParsing ?? false;
    this.args = options.args;
    this.runE = options.runE;
  }
  name() {
    return this.use.split(" ")[0];
  }
  addCommand(...cmds) {
    for (const cmd of cmds) {
      cmd.parent = this;
      this.children.push(cmd);
    }
  }
  /** 子命令，按名字排序（cobra 默认 EnableCommandSorting）。 */
  commands() {
    return [...this.children].sort((a, b) => a.name() < b.name() ? -1 : a.name() > b.name() ? 1 : 0);
  }
  flags() {
    return this.local;
  }
  persistentFlags() {
    return this.persistent;
  }
  runnable() {
    return this.runE !== void 0;
  }
  hasParent() {
    return this.parent !== void 0;
  }
  root() {
    return this.parent ? this.parent.root() : this;
  }
  commandPath() {
    return this.parent ? `${this.parent.commandPath()} ${this.name()}` : this.name();
  }
  isAvailableCommand() {
    return !this.hidden && (this.runnable() || this.children.some((c) => c.isAvailableCommand()));
  }
  hasAvailableSubCommands() {
    return this.children.some((c) => c.isAvailableCommand());
  }
  /** 持久参数：自己与祖先声明的 PersistentFlags。 */
  inheritedFlags() {
    const set = new FlagSet();
    for (let p = this.parent; p; p = p.parent) for (const f of p.persistent.formal.values()) set.addFlag(f);
    return set;
  }
  /** LocalFlags：本命令的 Flags 加上自己声明的持久参数。 */
  localFlags() {
    const set = new FlagSet();
    for (const f of this.local.formal.values()) set.addFlag(f);
    for (const f of this.persistent.formal.values()) set.addFlag(f);
    return set;
  }
  allFlags() {
    const set = this.localFlags();
    for (const f of this.inheritedFlags().formal.values()) set.addFlag(f);
    return set;
  }
  initDefaultFlags() {
    if (!this.local.lookup("help")) {
      const helpTarget = ref(false);
      this.local.boolVar(helpTarget, "help", false, `help for ${this.name() || "this command"}`, "h");
    }
    if (this.version && !this.local.lookup("version")) {
      const versionTarget = ref(false);
      this.local.boolVar(versionTarget, "version", false, `version for ${this.name() || "this command"}`, this.local.shorthandLookup("v") ? "" : "v");
    }
  }
  useLine() {
    const useline = this.parent ? `${this.parent.commandPath()} ${this.use}` : this.use;
    this.initDefaultFlags();
    return this.allFlags().hasAvailable() && !useline.includes("[flags]") ? useline + " [flags]" : useline;
  }
  namePadding() {
    if (!this.parent) return minNamePadding;
    const max = Math.max(0, ...this.parent.children.map((c) => c.name().length));
    return Math.max(minNamePadding, max);
  }
  /** cobra defaultUsageFunc。 */
  usageString() {
    this.initDefaultFlags();
    let w = "Usage:";
    if (this.runnable()) w += `
  ${this.useLine()}`;
    if (this.hasAvailableSubCommands()) w += `
  ${this.commandPath()} [command]`;
    if (this.aliases.length > 0) w += `

Aliases:
  ${[this.name(), ...this.aliases].join(", ")}`;
    if (this.example) w += `

Examples:
${this.example}`;
    if (this.hasAvailableSubCommands()) {
      w += "\n\nAvailable Commands:";
      for (const sub of this.commands()) {
        if (sub.isAvailableCommand() || sub.name() === "help") w += `
  ${sub.name().padEnd(sub.namePadding())} ${sub.short}`;
      }
    }
    const local = this.localFlags();
    if (local.hasAvailable()) w += "\n\nFlags:\n" + local.usages().trimEnd();
    const inherited = this.inheritedFlags();
    if (inherited.hasAvailable()) w += "\n\nGlobal Flags:\n" + inherited.usages().trimEnd();
    if (this.hasAvailableSubCommands()) w += `

Use "${this.commandPath()} [command] --help" for more information about a command.`;
    return w + "\n";
  }
  /** cobra defaultHelpFunc。 */
  helpString() {
    const text = (this.long || this.short).trimEnd();
    let out = text ? text + "\n\n" : "";
    if (this.runnable() || this.children.length > 0) out += this.usageString();
    return out;
  }
  // -------------------------------------------------------------- io
  setOut(out) {
    this.out = out;
  }
  setErr(err) {
    this.err = err;
  }
  outOrStdout() {
    return this.out ?? this.parent?.outOrStdout() ?? { write: (t) => process.stdout.write(t) };
  }
  errOrStderr() {
    return this.err ?? this.parent?.errOrStderr() ?? { write: (t) => process.stderr.write(t) };
  }
  setContext(signal) {
    this.signal = signal;
  }
  /** 对应 cmd.Context()：取消信号。 */
  context() {
    return this.signal ?? this.parent?.context() ?? new AbortController().signal;
  }
  // -------------------------------------------------------------- execution
  findNext(name) {
    return this.children.find((c) => c.name() === name || c.aliases.includes(name));
  }
  /** cobra Find：沿参数里的非参数词找到子命令；flag 与其取值跳过。 */
  find(args) {
    let cmd = this;
    let rest = [...args];
    for (; ; ) {
      const next = firstNonFlag(rest, cmd.allFlags());
      if (next === void 0) break;
      const child = cmd.findNext(next);
      if (!child) break;
      const index = rest.indexOf(next);
      rest = [...rest.slice(0, index), ...rest.slice(index + 1)];
      cmd = child;
    }
    return [cmd, rest];
  }
  suggestionsFor(typed) {
    const suggestions = [];
    for (const cmd of this.commands()) {
      if (!cmd.isAvailableCommand()) continue;
      const near = levenshtein(typed.toLowerCase(), cmd.name().toLowerCase()) <= 2;
      if (near || cmd.name().toLowerCase().startsWith(typed.toLowerCase())) suggestions.push(cmd.name());
    }
    return suggestions.length ? "\n\nDid you mean this?\n" + suggestions.map((s) => `	${s}
`).join("") : "";
  }
  /** pflag 的 Parse（interspersed）：返回非 flag 参数。 */
  parseFlags(args) {
    const flags = this.allFlags();
    const positional = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "--") {
        positional.push(...args.slice(i + 1));
        break;
      }
      if (arg.startsWith("--") && arg.length > 2) {
        const body = arg.slice(2);
        if (body.startsWith("-") || body.startsWith("=")) throw new FlagError(`bad flag syntax: ${arg}`);
        const eq = body.indexOf("=");
        const name = eq >= 0 ? body.slice(0, eq) : body;
        const flag = flags.lookup(name);
        if (!flag) throw new FlagError(`unknown flag: --${name}`);
        let value;
        if (eq >= 0) value = body.slice(eq + 1);
        else if (flag.noOptDefVal) value = flag.noOptDefVal;
        else if (i + 1 < args.length) value = args[++i];
        else throw new FlagError(`flag needs an argument: --${name}`);
        setFlag(flag, value, `--${name}`);
      } else if (arg.startsWith("-") && arg.length > 1) {
        const shorts = arg.slice(1);
        for (let j = 0; j < shorts.length; j++) {
          const c = shorts[j];
          const flag = flags.shorthandLookup(c);
          if (!flag) throw new FlagError(`unknown shorthand flag: ${goQuote3(c)} in -${shorts}`);
          let value;
          if (shorts[j + 1] === "=") {
            value = shorts.slice(j + 2);
            j = shorts.length;
          } else if (flag.noOptDefVal) value = flag.noOptDefVal;
          else if (j + 1 < shorts.length) {
            value = shorts.slice(j + 1);
            j = shorts.length;
          } else if (i + 1 < args.length) value = args[++i];
          else throw new FlagError(`flag needs an argument: ${goQuote3(c)} in -${shorts}`);
          setFlag(flag, value, `-${flag.shorthand}, --${flag.name}`);
        }
      } else positional.push(arg);
    }
    return positional;
  }
  /** 解析并执行。错误照 cobra 抛出，由调用方（cli.execute）决定打印与退出码。 */
  async execute(argv) {
    this.addHelpCommand();
    let [cmd, rest] = this.find(argv);
    if (cmd.name() === "help" && cmd.parent === this) {
      const [target] = this.find(rest.filter((a) => !a.startsWith("-")));
      cmd.outOrStdout().write(target.helpString());
      return;
    }
    cmd.initDefaultFlags();
    if (cmd.disableFlagParsing && cmd.runnable()) {
      await cmd.runE(cmd, rest);
      return;
    }
    const positional = cmd.parseFlags(rest);
    if (cmd.local.lookup("help")?.changed && helpRequested(cmd)) {
      cmd.outOrStdout().write(cmd.helpString());
      return;
    }
    if (cmd.version && cmd.local.lookup("version")?.changed) {
      cmd.outOrStdout().write(`${cmd.name()} version ${cmd.version}
`);
      return;
    }
    if (!cmd.runnable()) {
      if (!cmd.parent && positional.length > 0 && cmd.children.length > 0) {
        throw new Error(`unknown command ${goQuote3(positional[0])} for ${goQuote3(cmd.commandPath())}${cmd.suggestionsFor(positional[0])}`);
      }
      cmd.outOrStdout().write(cmd.helpString());
      return;
    }
    if (cmd.args) cmd.args(cmd, positional);
    else if (!cmd.parent && cmd.children.length > 0 && positional.length > 0) {
      throw new Error(`unknown command ${goQuote3(positional[0])} for ${goQuote3(cmd.commandPath())}${cmd.suggestionsFor(positional[0])}`);
    }
    await cmd.runE(cmd, positional);
  }
  addHelpCommand() {
    if (this.children.length === 0 || this.children.some((c) => c.name() === "help")) return;
    this.addCommand(
      new _Command({
        use: "help [command]",
        short: "Help about any command",
        long: `Help provides help for any command in the application.
Simply type ${this.name()} help [path to command] for full details.`,
        runE: () => {
        }
      })
    );
  }
};
function helpRequested(cmd) {
  const flag = cmd.flags().lookup("help");
  return flag !== void 0;
}
function setFlag(flag, value, display) {
  try {
    flag.set(value);
    flag.changed = true;
  } catch (err) {
    throw new FlagError(`invalid argument ${goQuote3(value)} for ${goQuote3(display)} flag: ${err instanceof Error ? err.message : String(err)}`);
  }
}
function firstNonFlag(args, flags) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") return void 0;
    if (arg.startsWith("--")) {
      const name = arg.slice(2).split("=")[0];
      const flag = flags.lookup(name);
      if (!arg.includes("=") && flag && !flag.noOptDefVal) i++;
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      const last = arg[arg.length - 1];
      const flag = flags.shorthandLookup(last);
      if (arg.length === 2 && flag && !flag.noOptDefVal) i++;
      continue;
    }
    return arg;
  }
  return void 0;
}
function levenshtein(s, t) {
  const d = Array.from({ length: s.length + 1 }, (_, i) => [i, ...Array(t.length).fill(0)]);
  for (let j = 0; j <= t.length; j++) d[0][j] = j;
  for (let j = 1; j <= t.length; j++) {
    for (let i = 1; i <= s.length; i++) {
      d[i][j] = s[i - 1] === t[j - 1] ? d[i - 1][j - 1] : Math.min(d[i - 1][j], d[i][j - 1], d[i - 1][j - 1]) + 1;
    }
  }
  return d[s.length][t.length];
}

// src/filmstyle.ts
var import_node_fs13 = __toESM(require("node:fs"), 1);
var import_node_path12 = __toESM(require("node:path"), 1);

// ../engine/src/filmstyle/filmstyle.ts
var import_node_os2 = __toESM(require("node:os"), 1);
var import_node_path5 = __toESM(require("node:path"), 1);
function styleKey(style3) {
  return style3.source + "/" + style3.slug;
}
function styleLabel(style3) {
  return `${style3.cn} ${style3.en}\uFF08${styleKey(style3)}\uFF09`;
}
var registry = [];
function register(source) {
  for (const existing of registry) {
    if (existing.id() === source.id()) throw new Error("filmstyle: \u98CE\u683C\u6765\u6E90\u91CD\u590D\u767B\u8BB0\uFF1A" + source.id());
  }
  registry.push(source);
  registry.sort((a, b) => compareBytes(a.id(), b.id()));
}
function sources() {
  return [...registry];
}
function sourceByID(id) {
  return registry.find((source) => source.id() === id);
}
function catalog() {
  const out = [];
  for (const source of registry) out.push(...source.catalog());
  return out;
}
function categories(sourceID) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const style3 of catalog()) {
    if (style3.source === sourceID && !seen.has(style3.category_cn)) {
      seen.add(style3.category_cn);
      out.push(style3.category_cn);
    }
  }
  return out;
}
function find(name) {
  const trimmed = goTrimSpace(name);
  const key = trimmed.toLowerCase();
  if (key === "") return { ok: false, ambiguous: [] };
  const matches = [];
  for (const candidate2 of catalog()) {
    if (styleKey(candidate2).toLowerCase() === key) return { style: candidate2, ok: true, ambiguous: [] };
    if (candidate2.slug.toLowerCase() === key || candidate2.en.toLowerCase() === key || candidate2.cn === trimmed) {
      matches.push(candidate2);
    }
  }
  if (matches.length === 0) return { ok: false, ambiguous: [] };
  if (matches.length === 1) return { style: matches[0], ok: true, ambiguous: [] };
  return { ok: false, ambiguous: matches };
}
function suggest(name) {
  const trimmed = goTrimSpace(name);
  const key = trimmed.toLowerCase();
  if (key === "") return [];
  const out = [];
  for (const style3 of catalog()) {
    if (styleKey(style3).toLowerCase().includes(key) || style3.en.toLowerCase().includes(key) || style3.cn.includes(trimmed)) {
      out.push(style3);
    }
  }
  return out.slice(0, 5);
}
function lookup(name) {
  const { style: style3, ok, ambiguous } = find(name);
  if (ok && style3) return style3;
  const labels = (list) => list.map(styleLabel).join("\u3001");
  if (ambiguous.length > 0) {
    throw new Error(`${goQuote(name)} \u5728\u591A\u4E2A\u98CE\u683C\u6765\u6E90\u91CC\u90FD\u6709\uFF1A${labels(ambiguous)}\u3002\u5199\u6210\u300C\u6765\u6E90/\u76EE\u5F55\u540D\u300D`);
  }
  let message = `\u98CE\u683C\u76EE\u5F55\u91CC\u6CA1\u6709 ${goQuote(name)}`;
  const candidates = suggest(name);
  if (candidates.length > 0) message += "\uFF0C\u76F8\u8FD1\u7684\u6709\uFF1A" + labels(candidates);
  throw new Error(`${message}\u3002\u7528 am film-style list \u67E5\u770B\u5168\u90E8\u98CE\u683C`);
}
var RootEnv = "AM_FILM_STYLES_DIR";
function rootDir(env) {
  const dir = env[RootEnv];
  if (dir) return dir;
  let base = env.XDG_DATA_HOME ?? "";
  if (base === "") {
    let home = env.HOME ?? "";
    if (home === "") home = import_node_os2.default.homedir();
    base = import_node_path5.default.join(home, ".local", "share");
  }
  return import_node_path5.default.join(base, "am", "film-styles");
}
function sourceDir(env, sourceID) {
  return import_node_path5.default.join(rootDir(env), sourceID);
}

// ../engine/src/filmstyle/install.ts
var import_node_crypto3 = __toESM(require("node:crypto"), 1);
var import_node_fs6 = __toESM(require("node:fs"), 1);
var import_node_path7 = __toESM(require("node:path"), 1);

// ../engine/src/fsutil/index.ts
var import_node_crypto2 = __toESM(require("node:crypto"), 1);
var import_node_fs5 = __toESM(require("node:fs"), 1);
var import_node_path6 = __toESM(require("node:path"), 1);
function atomicWrite(file, data, mode = 420) {
  const dir = import_node_path6.default.dirname(file);
  import_node_fs5.default.mkdirSync(dir, { recursive: true });
  const tmp = import_node_path6.default.join(dir, `.am-tmp-${import_node_crypto2.default.randomBytes(6).toString("hex")}`);
  try {
    import_node_fs5.default.writeFileSync(tmp, data, { mode });
    import_node_fs5.default.chmodSync(tmp, mode);
    import_node_fs5.default.renameSync(tmp, file);
  } catch (err) {
    try {
      import_node_fs5.default.rmSync(tmp, { force: true });
    } catch {
    }
    throw new Error(`\u5199\u5165 ${file}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
}

// ../engine/src/filmstyle/install.ts
var SkillsSubdir2 = ".agents/skills";
var SkillName = "am-film-style";
var ManifestFile2 = "am-film-style.json";
var StyleFile = "STYLE.md";
var GuideFile = "SKILL.md";
var LegacySkillName = "lemo-film-style";
var legacyManifest = "lemo-upstream.json";
var legacySource = "lemo-opuscar";
function manifestKey(manifest) {
  return manifest.source + "/" + manifest.slug;
}
function skillDir(projectDir) {
  return import_node_path7.default.join(projectDir, SkillsSubdir2, SkillName);
}
function legacyDir(projectDir) {
  return import_node_path7.default.join(projectDir, SkillsSubdir2, LegacySkillName);
}
function exists2(file) {
  try {
    import_node_fs6.default.statSync(file);
    return true;
  } catch {
    return false;
  }
}
function installedDir(projectDir) {
  if (exists2(import_node_path7.default.join(skillDir(projectDir), ManifestFile2))) return skillDir(projectDir);
  if (exists2(import_node_path7.default.join(legacyDir(projectDir), legacyManifest))) return legacyDir(projectDir);
  return "";
}
function readOptional(file) {
  try {
    return import_node_fs6.default.readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return void 0;
    throw new Error(goPathError("open", file, err), { cause: err });
  }
}
function stringField(object, name) {
  let value;
  if (Object.hasOwn(object, name)) value = object[name];
  else {
    const lower = name.toLowerCase();
    const key = Object.keys(object).find((k) => k.toLowerCase() === lower);
    value = key === void 0 ? void 0 : object[key];
  }
  if (value === void 0 || value === null) return "";
  if (typeof value !== "string") throw new Error(`json: cannot unmarshal ${jsonKind(value)} into Go struct field .${name} of type string`);
  return value;
}
function jsonKind(value) {
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  return typeof value;
}
function decodeObject(body) {
  const value = JSON.parse(body);
  if (value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`json: cannot unmarshal ${jsonKind(value)} into Go value of type struct`);
  }
  return value;
}
function errorText2(err) {
  return err instanceof Error ? err.message : String(err);
}
function installed(projectDir) {
  const empty = { source: "", slug: "", cn: "", en: "", version: "", digest: "", installed_at: "", legacy: false };
  let body = readOptional(import_node_path7.default.join(skillDir(projectDir), ManifestFile2));
  if (body !== void 0) {
    try {
      const raw = decodeObject(body);
      return {
        manifest: {
          source: stringField(raw, "source"),
          slug: stringField(raw, "slug"),
          cn: stringField(raw, "cn"),
          en: stringField(raw, "en"),
          version: stringField(raw, "version"),
          digest: stringField(raw, "digest"),
          installed_at: stringField(raw, "installed_at"),
          legacy: false
        },
        ok: true
      };
    } catch (err) {
      throw new Error(`${ManifestFile2} \u635F\u574F\uFF1A${errorText2(err)}`, { cause: err });
    }
  }
  body = readOptional(import_node_path7.default.join(legacyDir(projectDir), legacyManifest));
  if (body === void 0) return { manifest: empty, ok: false };
  try {
    const raw = decodeObject(body);
    return {
      manifest: {
        source: legacySource,
        slug: stringField(raw, "Slug"),
        cn: stringField(raw, "CN"),
        en: stringField(raw, "EN"),
        version: stringField(raw, "Commit"),
        digest: stringField(raw, "Digest"),
        installed_at: stringField(raw, "installed_at"),
        legacy: true
      },
      ok: true
    };
  } catch (err) {
    throw new Error(`${legacyManifest} \u635F\u574F\uFF1A${errorText2(err)}`, { cause: err });
  }
}
function rfc3339(now) {
  return now.toISOString().replace(/\.\d+Z$/, "Z");
}
function linkError(op, from, to, err) {
  return goPathError(op, `${from} ${to}`, err);
}
function install2(opts) {
  const style3 = opts.style;
  const source = sourceByID(style3.source);
  if (!source) throw new Error(`\u6CA1\u6709\u98CE\u683C\u6765\u6E90 ${goQuote(style3.source)}`);
  const { manifest: previous, ok: had } = installed(opts.projectDir);
  if (had && manifestKey(previous) !== styleKey(style3) && !opts.replace) {
    throw new Error(
      `\u9879\u76EE\u5DF2\u4F7F\u7528\u6574\u7247\u98CE\u683C ${previous.cn} ${previous.en}\uFF08${manifestKey(previous)}\uFF09\u3002\u6362\u6210 ${styleLabel(style3)} \u4F1A\u8BA9\u5168\u90E8\u955C\u5934\u9700\u8981\u91CD\u6E32\u67D3\uFF1B\u786E\u8BA4\u8981\u6362\u5C31\u52A0 --replace`
    );
  }
  const parent = import_node_path7.default.dirname(skillDir(opts.projectDir));
  import_node_fs6.default.mkdirSync(parent, { recursive: true });
  const staging = import_node_fs6.default.mkdtempSync(import_node_path7.default.join(parent, "." + SkillName + "-"));
  try {
    const version = source.fill(staging, style3, opts.env ?? {});
    for (const required of [StyleFile, GuideFile]) {
      if (!exists2(import_node_path7.default.join(staging, required))) {
        throw new Error(`\u98CE\u683C\u6765\u6E90 ${source.id()} \u6CA1\u6709\u5199\u51FA ${required}\uFF1A\u8FDD\u53CD\u6574\u7247\u98CE\u683C\u5951\u7EA6`);
      }
    }
    const digest2 = treeDigest(staging);
    if (had && !previous.legacy && manifestKey(previous) === styleKey(style3) && previous.digest === digest2 && previous.version === version) {
      return { manifest: previous, unchanged: true, replaced: "" };
    }
    const manifest = {
      source: style3.source,
      slug: style3.slug,
      cn: style3.cn,
      en: style3.en,
      version,
      digest: digest2,
      installed_at: rfc3339(opts.now ?? /* @__PURE__ */ new Date()),
      legacy: false
    };
    const body = marshalIndent({
      source: manifest.source,
      slug: manifest.slug,
      cn: manifest.cn,
      en: manifest.en,
      version: manifest.version,
      digest: manifest.digest,
      installed_at: manifest.installed_at
    });
    atomicWrite(import_node_path7.default.join(staging, ManifestFile2), body + "\n", 420);
    const target = skillDir(opts.projectDir);
    let backup = "";
    if (exists2(target)) {
      backup = staging + ".old";
      try {
        import_node_fs6.default.renameSync(target, backup);
      } catch (err) {
        throw new Error(`\u79FB\u5F00\u65E7\u7684\u6574\u7247\u98CE\u683C\uFF1A${linkError("rename", target, backup, err)}`, { cause: err });
      }
    }
    try {
      import_node_fs6.default.renameSync(staging, target);
    } catch (err) {
      if (backup !== "") {
        try {
          import_node_fs6.default.renameSync(backup, target);
        } catch {
        }
      }
      throw new Error(`\u653E\u7F6E\u6574\u7247\u98CE\u683C\uFF1A${linkError("rename", staging, target, err)}`, { cause: err });
    }
    if (backup !== "") import_node_fs6.default.rmSync(backup, { recursive: true, force: true });
    try {
      import_node_fs6.default.rmSync(legacyDir(opts.projectDir), { recursive: true, force: true });
    } catch {
    }
    const result = { manifest, unchanged: false, replaced: "" };
    if (had && manifestKey(previous) !== styleKey(style3)) result.replaced = manifestKey(previous);
    return result;
  } finally {
    import_node_fs6.default.rmSync(staging, { recursive: true, force: true });
  }
}
function remove(projectDir) {
  const { manifest, ok } = installed(projectDir);
  if (!ok) return { manifest, had: false };
  import_node_fs6.default.rmSync(skillDir(projectDir), { recursive: true, force: true });
  import_node_fs6.default.rmSync(legacyDir(projectDir), { recursive: true, force: true });
  return { manifest, had: true };
}
function sortedEntries(dir) {
  return import_node_fs6.default.readdirSync(dir, { withFileTypes: true }).sort((a, b) => compareBytes(a.name, b.name));
}
function treeDigest(root) {
  const files2 = [];
  const walk = (dir, rel) => {
    for (const entry of sortedEntries(dir)) {
      const childRel = rel === "" ? entry.name : rel + "/" + entry.name;
      if (entry.isDirectory()) walk(import_node_path7.default.join(dir, entry.name), childRel);
      else if (entry.isFile() && entry.name !== ManifestFile2) files2.push(childRel);
    }
  };
  walk(root, "");
  files2.sort(compareBytes);
  const hash = import_node_crypto3.default.createHash("sha256");
  for (const rel of files2) {
    const sum = import_node_crypto3.default.createHash("sha256").update(import_node_fs6.default.readFileSync(import_node_path7.default.join(root, rel))).digest("hex");
    hash.update(`${rel} ${sum}
`);
  }
  return "sha256:" + hash.digest("hex");
}

// ../engine/src/filmstyle/lemo/catalog.json
var catalog_default = [
  {
    slug: "crayon-book",
    num: "01",
    en: "Crayon Picture Book",
    cn: "\u8721\u7B14\u513F\u7AE5\u7ED8\u672C",
    category_en: "Hand-drawn & Painting",
    category_cn: "\u624B\u7ED8\u4E0E\u7ED8\u753B",
    film: "The Moon Can't Sleep",
    line: "The moon can't sleep, so a little girl climbs onto the roof to sing it a lullaby.",
    line_cn: "\u6708\u4EAE\u5931\u7720\u4E86\uFF0C\u5C0F\u5973\u5B69\u722C\u4E0A\u5C4B\u9876\u7ED9\u5B83\u5531\u6447\u7BEE\u66F2\u3002",
    uses: [
      "Picture books",
      "Bedtime stories",
      "Kids' learning"
    ],
    demo_seconds: 52,
    three_js: false
  },
  {
    slug: "watercolor",
    num: "02",
    en: "Watercolor Brush",
    cn: "\u6C34\u5F69\u7B14\u5237",
    category_en: "Hand-drawn & Painting",
    category_cn: "\u624B\u7ED8\u4E0E\u7ED8\u753B",
    film: "Follow the Rain",
    line: "Follow the rain from Australia's red desert heart to its green coast in one unbroken painted walk.",
    line_cn: "\u8DDF\u7740\u964D\u96E8\u4ECE\u6FB3\u6D32\u7EA2\u8272\u8179\u5730\u4E00\u8DEF\u753B\u5230\u7EFF\u8272\u6D77\u5CB8\uFF0C\u4E00\u955C\u5230\u5E95\u3002",
    uses: [
      "Nature documentary",
      "Travel",
      "Science explainers"
    ],
    demo_seconds: 113.6,
    three_js: false
  },
  {
    slug: "ink-wash",
    num: "03",
    en: "Chinese Ink Wash",
    cn: "\u4E2D\u56FD\u6C34\u58A8",
    category_en: "Hand-drawn & Painting",
    category_cn: "\u624B\u7ED8\u4E0E\u7ED8\u753B",
    film: "The Swordsman and the River",
    line: "A swordsman crosses the river on the water and splits the current with a single stroke.",
    line_cn: "\u4FA0\u5BA2\u8E0F\u6C34\u8FC7\u6C5F\uFF0C\u4E00\u5251\u65AD\u6D41\u3002",
    uses: [
      "Wuxia",
      "Cultural brands",
      "Poetry"
    ],
    demo_seconds: 48,
    three_js: false
  },
  {
    slug: "impasto",
    num: "04",
    en: "Impasto Oil Painting",
    cn: "\u6CB9\u753B\u539A\u6D82",
    category_en: "Hand-drawn & Painting",
    category_cn: "\u624B\u7ED8\u4E0E\u7ED8\u753B",
    film: "The Colour of Rain",
    line: "In a grey, rainy square one red umbrella opens, and a waltz paints the whole plaza in colour.",
    line_cn: "\u7070\u8272\u96E8\u4E2D\u5E7F\u573A\uFF0C\u7B2C\u4E00\u628A\u7EA2\u4F1E\u6491\u5F00\uFF0C\u5706\u821E\u66F2\u628A\u6574\u4E2A\u5E7F\u573A\u5237\u4E0A\u989C\u8272\u3002",
    uses: [
      "Music videos",
      "Art & culture",
      "Emotional ads"
    ],
    demo_seconds: 39.7,
    three_js: false
  },
  {
    slug: "one-line",
    num: "05",
    en: "One-line Drawing",
    cn: "\u4E00\u7B14\u753B",
    category_en: "Hand-drawn & Painting",
    category_cn: "\u624B\u7ED8\u4E0E\u7ED8\u753B",
    film: "The Line That Never Lifted",
    line: "One unbroken line draws a whole life, then the pen passes to a child.",
    line_cn: "\u4E00\u6839\u4E0D\u79BB\u7EB8\u7684\u7EBF\u753B\u5B8C\u4E00\u4E2A\u4EBA\u7684\u4E00\u751F\uFF0C\u518D\u628A\u7B14\u4EA4\u7ED9\u5B69\u5B50\u3002",
    uses: [
      "Brand stories",
      "Life milestones",
      "Minimal ads"
    ],
    demo_seconds: 47.5,
    three_js: false
  },
  {
    slug: "whiteboard",
    num: "06",
    en: "Whiteboard Explainer",
    cn: "\u767D\u677F\u8BB2\u89E3",
    category_en: "Hand-drawn & Painting",
    category_cn: "\u624B\u7ED8\u4E0E\u7ED8\u753B",
    film: "Einstein in Your Pocket",
    line: "How your phone knows where you are: GPS, atomic clocks, and the 38 microseconds relativity adds every day.",
    line_cn: "\u624B\u673A\u600E\u4E48\u77E5\u9053\u4F60\u5728\u54EA\uFF1AGPS\u3001\u539F\u5B50\u949F\uFF0C\u548C\u76F8\u5BF9\u8BBA\u6BCF\u5929\u591A\u51FA\u7684 38 \u5FAE\u79D2\u3002",
    uses: [
      "Explainers",
      "Online courses",
      "Science"
    ],
    demo_seconds: 111,
    three_js: false
  },
  {
    slug: "shadow-puppet",
    num: "07",
    en: "Shadow Puppetry",
    cn: "\u76AE\u5F71\u620F",
    category_en: "East Asian Traditions",
    category_cn: "\u4E1C\u65B9\u4F20\u7EDF",
    film: "Hou Yi Shoots the Suns",
    line: "Ten suns scorch the earth until the archer Hou Yi draws his bow, told with leather puppets on a lit screen.",
    line_cn: "\u5341\u65E5\u7099\u70E4\u5927\u5730\uFF0C\u540E\u7FBF\u5F20\u5F13\u5C04\u65E5\u3002",
    uses: [
      "Myths & folklore",
      "Heritage",
      "Festivals"
    ],
    demo_seconds: 54.4,
    three_js: false
  },
  {
    slug: "ukiyoe",
    num: "08",
    en: "Ukiyo-e",
    cn: "\u6D6E\u4E16\u7ED8",
    category_en: "East Asian Traditions",
    category_cn: "\u4E1C\u65B9\u4F20\u7EDF",
    film: "Toward the Mountain",
    line: "A traveller walks toward a distant mountain; every shot is a woodblock print, a great wave at the climax, the mountain and the whole scroll at the end.",
    line_cn: "\u65C5\u4EBA\u8D70\u5411\u8FDC\u5C71\uFF0C\u6BCF\u4E2A\u955C\u5934\u90FD\u662F\u4E00\u5E45\u7248\u753B\uFF1B\u5DE8\u6D6A\u662F\u9AD8\u6F6E\uFF0C\u7ED3\u5C3E\u662F\u8FDC\u5C71\u4E0E\u6574\u5E45\u753B\u8F74\u62C9\u8FDC\u3002",
    uses: [
      "Travel",
      "Japanese culture",
      "Poetry"
    ],
    demo_seconds: 44,
    three_js: false
  },
  {
    slug: "papercut-red",
    num: "09",
    en: "Red Paper-cut",
    cn: "\u7EA2\u8272\u7A97\u82B1\u526A\u7EB8",
    category_en: "East Asian Traditions",
    category_cn: "\u4E1C\u65B9\u4F20\u7EDF",
    film: "Nian Comes to Town",
    line: "On New Year's Eve the beast Nian comes to town, and one girl's giant paper-cut lights up the village to scare it off.",
    line_cn: "\u9664\u5915\u5E74\u517D\u8FDB\u6751\uFF0C\u5C0F\u5973\u5B69\u526A\u51FA\u7684\u5927\u7A97\u82B1\u7167\u4EAE\u5168\u6751\uFF0C\u628A\u5B83\u5413\u8DD1\u3002",
    uses: [
      "Lunar New Year",
      "Festive greetings",
      "Folk tales"
    ],
    demo_seconds: 49,
    three_js: false
  },
  {
    slug: "paper-lantern",
    num: "10",
    en: "Paper-cut Lightbox",
    cn: "\u7EB8\u96D5\u706F\u5F71",
    category_en: "East Asian Traditions",
    category_cn: "\u4E1C\u65B9\u4F20\u7EDF",
    film: "The Last Night Train",
    line: "An old night train makes its last run, from a snowy mountain halt through a long tunnel to the sea, its lit windows going out one by one at the end of the line.",
    line_cn: "\u4E00\u5217\u8001\u591C\u8F66\u8DD1\u6700\u540E\u4E00\u8D9F\uFF1A\u4ECE\u96EA\u5C71\u5C0F\u7AD9\u7A7F\u8FC7\u957F\u96A7\u9053\u5F00\u5230\u6D77\u8FB9\uFF0C\u5230\u7AD9\u540E\u8F66\u7A97\u4E00\u6247\u6247\u7184\u706D\u3002",
    uses: [
      "Journeys and travel",
      "Farewells and anniversaries",
      "Places and their stories"
    ],
    demo_seconds: 51,
    three_js: true
  },
  {
    slug: "risograph",
    num: "12",
    en: "Risograph Print",
    cn: "Risograph \u5B54\u7248\u5370\u5237",
    category_en: "Print & Printmaking",
    category_cn: "\u5370\u5237\u4E0E\u7248\u753B",
    film: "Sunday Ride",
    line: "A Sunday-morning bike ride through the city \u2014 bakery, park, riverside \u2014 each stop adding an ink until three misregistered plates overprint.",
    line_cn: "\u5468\u65E5\u65E9\u6668\u9A91\u8F66\u7A7F\u8FC7\u57CE\u5E02\uFF1A\u9762\u5305\u5E97\u3001\u516C\u56ED\u3001\u6CB3\u8FB9\uFF0C\u6BCF\u5230\u4E00\u5904\u52A0\u4E00\u7248\u6CB9\u58A8\uFF0C\u6700\u540E\u4E09\u7248\u5957\u5370\u3002",
    uses: [
      "Indie brands",
      "Zines",
      "Lifestyle"
    ],
    demo_seconds: 40,
    three_js: false
  },
  {
    slug: "halftone-dossier",
    num: "13",
    en: "Halftone Dossier",
    cn: "\u590D\u53E4\u534A\u8C03\u6848\u5377",
    category_en: "Print & Printmaking",
    category_cn: "\u5370\u5237\u4E0E\u7248\u753B",
    film: "Case File: Chubby",
    line: "A chubby orange cat stands trial for testing gravity and 4 a.m. parkour, and walks free.",
    line_cn: "\u6A58\u732B\u80D6\u6A58\u88AB\u7ACB\u6848\u5BA1\u67E5\uFF1A\u6D4B\u8BD5\u91CD\u529B\u3001\u51CC\u6668\u8DD1\u9177\uFF0C\u6700\u540E\u65E0\u7F6A\u91CA\u653E\u3002",
    uses: [
      "Humour",
      "Pet content",
      "Social shorts"
    ],
    demo_seconds: 30,
    three_js: false
  },
  {
    slug: "woodcut",
    num: "15",
    en: "Woodcut Print",
    cn: "\u6728\u523B\u7248\u753B",
    category_en: "Print & Printmaking",
    category_cn: "\u5370\u5237\u4E0E\u7248\u753B",
    film: "The Bell Founder",
    line: "A village spends a whole winter casting one bell; the first time it rings, the snow stops.",
    line_cn: "\u6751\u5B50\u7528\u4E00\u6574\u4E2A\u51AC\u5929\u94F8\u4E00\u53E3\u949F\uFF0C\u949F\u58F0\u7B2C\u4E00\u6B21\u54CD\u8D77\uFF0C\u96EA\u505C\u4E86\u3002",
    uses: [
      "Folk tales",
      "Craft brands",
      "Book trailers"
    ],
    demo_seconds: 58.5,
    three_js: false
  },
  {
    slug: "swiss-motion",
    num: "16",
    en: "Swiss Motion Graphics",
    cn: "\u745E\u58EB\u52A8\u6001\u6392\u7248",
    category_en: "Graphic & Type",
    category_cn: "\u56FE\u5F62\u4E0E\u6392\u7248",
    film: "Five Rules for a Poster",
    line: "A concert poster lays itself out by five Swiss design rules; the fifth is to break just one.",
    line_cn: "\u4E00\u5F20\u97F3\u4E50\u4F1A\u6D77\u62A5\u6309\u745E\u58EB\u8BBE\u8BA1\u7684\u4E94\u6761\u89C4\u5219\u81EA\u5DF1\u6392\u7248\uFF0C\u7B2C\u4E94\u6761\u662F\u53EA\u6253\u7834\u4E00\u6761\u3002",
    uses: [
      "Brand identity",
      "Events",
      "Design education"
    ],
    demo_seconds: 44,
    three_js: false
  },
  {
    slug: "spy-titles",
    num: "17",
    en: "60s Spy Title Sequence",
    cn: "60s \u95F4\u8C0D\u7247\u5934",
    category_en: "Graphic & Type",
    category_cn: "\u56FE\u5F62\u4E0E\u6392\u7248",
    film: "The Velvet Cipher",
    line: "Opening titles for an imaginary 1964 spy film: a chase for a stolen key until the shapes lock into the title.",
    line_cn: "\u865A\u6784 1964 \u5E74\u95F4\u8C0D\u7247\u7684\u7247\u5934\uFF1A\u8FFD\u4E00\u628A\u88AB\u5077\u7684\u94A5\u5319\uFF0C\u51E0\u4F55\u788E\u7247\u6700\u540E\u62FC\u6210\u7247\u540D\u3002",
    uses: [
      "Title sequences",
      "Event openers",
      "Trailers"
    ],
    demo_seconds: 44.1,
    three_js: false
  },
  {
    slug: "art-deco",
    num: "18",
    en: "Art Deco",
    cn: "\u88C5\u9970\u827A\u672F",
    category_en: "Graphic & Type",
    category_cn: "\u56FE\u5F62\u4E0E\u6392\u7248",
    film: "Midnight at the Starlight Hotel",
    line: "A grand hotel, 1930: a bellboy races lifts and revolving doors to deliver one letter before midnight.",
    line_cn: "1930 \u5E74\u7684\u5927\u996D\u5E97\uFF0C\u95E8\u7AE5\u8D76\u5728\u5348\u591C\u524D\u628A\u4E00\u5C01\u4FE1\u9001\u4E0A\u9876\u697C\u3002",
    uses: [
      "Luxury & hospitality",
      "Galas",
      "Invitations"
    ],
    demo_seconds: 58.4,
    three_js: false
  },
  {
    slug: "blueprint",
    num: "19",
    en: "Blueprint",
    cn: "\u84DD\u56FE / \u5DE5\u7A0B\u5236\u56FE",
    category_en: "Graphic & Type",
    category_cn: "\u56FE\u5F62\u4E0E\u6392\u7248",
    film: "Patent Pending: The Cloud Catcher",
    line: "An inventor's blueprint draws, explodes and assembles a cloud-catching machine, and its revision cloud starts to rain.",
    line_cn: "\u53D1\u660E\u5BB6\u7684\u84DD\u56FE\u81EA\u5DF1\u753B\u51FA\u4E00\u53F0\u63A5\u4E91\u673A\u5668\uFF0C\u4FEE\u8BA2\u4E91\u7EBF\u53D8\u6210\u4E86\u771F\u7684\u96E8\u4E91\u3002",
    uses: [
      "Engineering",
      "Hardware launches",
      "Tech explainers"
    ],
    demo_seconds: 46.7,
    three_js: false
  },
  {
    slug: "stained-glass",
    num: "20",
    en: "Stained Glass",
    cn: "\u5F69\u8272\u73BB\u7483\u7A97",
    category_en: "Graphic & Type",
    category_cn: "\u56FE\u5F62\u4E0E\u6392\u7248",
    film: "The Dragon of the East Window",
    line: "Sunlight crosses a cathedral window from dawn to dusk, waking each pane of a knight-and-dragon tale.",
    line_cn: "\u9633\u5149\u4ECE\u6E05\u6668\u79FB\u5230\u9EC4\u660F\uFF0C\u7167\u5230\u54EA\u4E00\u683C\u82B1\u7A97\uFF0C\u54EA\u4E00\u683C\u7684\u6545\u4E8B\u5C31\u52A8\u8D77\u6765\u3002",
    uses: [
      "Legends",
      "Heritage",
      "Holiday stories"
    ],
    demo_seconds: 56.5,
    three_js: false
  },
  {
    slug: "pictogram-motion",
    num: "21",
    en: "Pictogram Motion",
    cn: "\u8C61\u5F62\u8FD0\u52A8\u56FE\u5F62",
    category_en: "Graphic & Type",
    category_cn: "\u56FE\u5F62\u4E0E\u6392\u7248",
    film: "Left Behind",
    line: "A yellow umbrella left on a bus waits out a sunny day on the lost-property shelf, then opens with 312 others when the storm comes back: objects, vehicles, weather and signs as beat-locked geometric pictograms.",
    line_cn: "\u4E00\u628A\u88AB\u843D\u5728\u516C\u4EA4\u8F66\u4E0A\u7684\u9EC4\u4F1E\uFF0C\u6674\u5929\u91CC\u5728\u5931\u7269\u62DB\u9886\u7684\u8D27\u67B6\u4E0A\u7B49\u4E86\u4E00\u6574\u5929\uFF0C\u66B4\u96E8\u56DE\u6765\u65F6\u548C\u53E6\u5916 312 \u628A\u4E00\u8D77\u6491\u5F00\uFF1A\u7269\u4EF6\u3001\u4EA4\u901A\u3001\u5929\u6C14\u548C\u6807\u8BC6\uFF0C\u90FD\u662F\u5361\u7740\u8282\u62CD\u7684\u51E0\u4F55\u8C61\u5F62\u7B26\u53F7\u3002",
    uses: [
      "Public services and city stories",
      "Brand and event identity films",
      "Explainers told through signs and objects"
    ],
    demo_seconds: 50,
    three_js: false
  },
  {
    slug: "ascii-crt",
    num: "22",
    en: "ASCII / CRT Terminal",
    cn: "ASCII / CRT \u7EC8\u7AEF",
    category_en: "Graphic & Type",
    category_cn: "\u56FE\u5F62\u4E0E\u6392\u7248",
    film: "Tranquility.log",
    line: "A moon-base AI wakes after forty years to a signal from Earth, and replies by drawing \u201Chome\u201D in characters.",
    line_cn: "\u6708\u7403\u57FA\u5730\u7684 AI \u6C89\u7761 40 \u5E74\u540E\u88AB\u5524\u9192\uFF0C\u7528\u5B57\u7B26\u753B\u51FA\u201C\u5BB6\u201D\u6765\u56DE\u590D\u3002",
    uses: [
      "Developer tools",
      "Sci-fi",
      "Tech brands"
    ],
    demo_seconds: 59.8,
    three_js: false
  },
  {
    slug: "dataviz",
    num: "23",
    en: "Data Storytelling",
    cn: "\u6570\u636E\u53D9\u4E8B",
    category_en: "Information & Keynote",
    category_cn: "\u4FE1\u606F\u4E0E\u53D1\u5E03",
    film: "A Hundred Summers",
    line: "A hundred years of summer temperatures, where the chart itself tells the story.",
    line_cn: "\u4E00\u767E\u5E74\u7684\u590F\u5B63\u6C14\u6E29\uFF0C\u56FE\u8868\u672C\u8EAB\u5C31\u662F\u6545\u4E8B\u3002",
    uses: [
      "Data journalism",
      "Reports",
      "Climate & science"
    ],
    demo_seconds: 50,
    three_js: false
  },
  {
    slug: "iso-infographic",
    num: "24",
    en: "Isometric Infographic",
    cn: "\u7B49\u8DDD\u4FE1\u606F\u56FE",
    category_en: "Information & Keynote",
    category_cn: "\u4FE1\u606F\u4E0E\u53D1\u5E03",
    film: "From Bean to Cup",
    line: "A coffee's journey from the plantation to your hands, across one isometric world.",
    line_cn: "\u4E00\u676F\u5496\u5561\u4ECE\u79CD\u690D\u56ED\u5230\u4F60\u624B\u91CC\u7684\u65C5\u7A0B\u3002",
    uses: [
      "Process explainers",
      "Supply chains",
      "Annual reports"
    ],
    demo_seconds: 58.8,
    three_js: false
  },
  {
    slug: "dark-keynote",
    num: "25",
    en: "Dark Tech Keynote",
    cn: "\u6697\u8272\u79D1\u6280\u53D1\u5E03",
    category_en: "Information & Keynote",
    category_cn: "\u4FE1\u606F\u4E0E\u53D1\u5E03",
    film: "Room to Think",
    line: "Launch film for Tidy, a fictional app: one buried cursor snaps hundreds of windows back into place.",
    line_cn: "\u865A\u6784 app Tidy \u7684\u53D1\u5E03\u7247\uFF1A\u88AB\u57CB\u6389\u7684\u5149\u6807\u4E00\u952E\u628A\u51E0\u767E\u4E2A\u7A97\u53E3\u5F52\u4F4D\u3002",
    uses: [
      "Product launches",
      "SaaS",
      "Keynotes"
    ],
    demo_seconds: 42,
    three_js: false
  },
  {
    slug: "rubber-hose",
    num: "26",
    en: "1930s Rubber Hose Cartoon",
    cn: "1930s \u6A61\u76AE\u7BA1\u5361\u901A",
    category_en: "Cartoon & Anime",
    category_cn: "\u5361\u901A\u4E0E\u52A8\u753B",
    film: "Coffee Cup Chase",
    line: "A coffee cup chases a runaway sugar cube around the kitchen, 1930s-cartoon style.",
    line_cn: "\u4E00\u53EA\u5496\u5561\u676F\u6EE1\u53A8\u623F\u8FFD\u4E00\u5757\u9003\u8DD1\u7684\u65B9\u7CD6\u3002",
    uses: [
      "Food & drink",
      "Retro ads",
      "Kids"
    ],
    demo_seconds: 50,
    three_js: false
  },
  {
    slug: "cel-anime-80s",
    num: "27",
    en: "80s Cel Anime",
    cn: "80 \u5E74\u4EE3\u8D5B\u7490\u7490\u52A8\u753B",
    category_en: "Cartoon & Anime",
    category_cn: "\u5361\u901A\u4E0E\u52A8\u753B",
    film: "City Lights, 1987",
    line: "A courier girl rides through a rain-soaked neon city to deliver a tape before the dawn launch.",
    line_cn: "\u5FEB\u9012\u5C11\u5973\u9A91\u8F66\u7A7F\u8FC7\u96E8\u540E\u9713\u8679\u90FD\u5E02\uFF0C\u8D76\u5728\u9ECE\u660E\u53D1\u5C04\u524D\u9001\u5230\u4E00\u76D8\u78C1\u5E26\u3002",
    uses: [
      "Music videos",
      "Game trailers",
      "Nostalgia"
    ],
    demo_seconds: 59,
    three_js: false
  },
  {
    slug: "scifi-toon",
    num: "28",
    en: "Sci-Fi Sitcom Toon",
    cn: "\u79D1\u5E7B\u60C5\u666F\u559C\u5267\u5361\u901A",
    category_en: "Cartoon & Anime",
    category_cn: "\u5361\u901A\u4E0E\u52A8\u753B",
    film: "Coffee Run",
    line: "A jaded genius opens a portal just to buy coffee and tumbles through ever-stranger universes.",
    line_cn: "\u538C\u4E16\u5929\u624D\u5F00\u4F20\u9001\u95E8\u53EA\u60F3\u4E70\u676F\u5496\u5561\uFF0C\u5374\u7A7F\u8FC7\u8D8A\u6765\u8D8A\u79BB\u8C31\u7684\u5E73\u884C\u5B87\u5B99\u3002",
    uses: [
      "Comedy",
      "Tech brands",
      "Social shorts"
    ],
    demo_seconds: 57.5,
    three_js: false
  },
  {
    slug: "pixel-rpg",
    num: "29",
    en: "16-bit Pixel RPG",
    cn: "16-bit \u50CF\u7D20 RPG",
    category_en: "Games",
    category_cn: "\u6E38\u620F",
    film: "The Last Save Point",
    line: "At the final boss door a hero saves the game, and the save screen replays the whole journey.",
    line_cn: "\u52C7\u58EB\u5728\u6700\u7EC8 Boss \u95E8\u524D\u5B58\u6863\uFF0C\u5B58\u6863\u753B\u9762\u95EA\u56DE\u4E00\u8DEF\u5192\u9669\u3002",
    uses: [
      "Game trailers",
      "Recaps",
      "Nostalgia"
    ],
    demo_seconds: 54.5,
    three_js: false
  },
  {
    slug: "hd-2d",
    num: "31",
    en: "HD-2D",
    cn: "HD-2D",
    category_en: "Games",
    category_cn: "\u6E38\u620F",
    film: "The Lampbearer",
    line: "The lighthouse goes dark; a girl carries the last flame through a night forest and up the storm cliffs.",
    line_cn: "\u706F\u5854\u7184\u706D\uFF0C\u5B59\u5973\u63D0\u7740\u6700\u540E\u4E00\u7C07\u706B\u7A7F\u8FC7\u591C\u6797\u3001\u722C\u4E0A\u98CE\u66B4\u60AC\u5D16\u3002",
    uses: [
      "Game trailers",
      "Fantasy",
      "Story films"
    ],
    demo_seconds: 76.5,
    three_js: true
  },
  {
    slug: "microgame",
    num: "32",
    en: "Microgame Frenzy",
    cn: "\u5FAE\u6E38\u620F\u5FEB\u95EA",
    category_en: "Games",
    category_cn: "\u6E38\u620F",
    film: "Five-Second Astronaut",
    line: "A clumsy cadet survives a five-second boot camp, faster and faster, until the boss: landing home.",
    line_cn: "\u89C1\u4E60\u5B87\u822A\u5458\u95EF\u4E94\u79D2\u8BAD\u7EC3\u8425\uFF0C\u8D8A\u6765\u8D8A\u5FEB\uFF0CBoss \u5173\u4EB2\u624B\u964D\u843D\u56DE\u5730\u7403\u3002",
    uses: [
      "Game trailers",
      "Onboarding",
      "Social shorts"
    ],
    demo_seconds: 59.8,
    three_js: false
  },
  {
    slug: "game-show",
    num: "33",
    en: "Game Show Flat",
    cn: "\u7EFC\u827A\u8282\u594F\u6241\u5E73",
    category_en: "Games",
    category_cn: "\u6E38\u620F",
    film: "Rhythm of AI, 1997 \u2192 2026",
    line: "The history of AI as a rhythm game: models take the stage on the beat, and a report card closes the show.",
    line_cn: "\u628A AI \u53D1\u5C55\u53F2\u505A\u6210\u4E00\u5C40\u8282\u594F\u6E38\u620F\uFF0C\u6A21\u578B\u8E29\u7740\u62CD\u767B\u573A\uFF0C\u6700\u540E\u53D1\u6210\u7EE9\u5355\u3002",
    uses: [
      "Tech timelines",
      "Year in review",
      "Variety shows"
    ],
    demo_seconds: 148.8,
    three_js: false
  },
  {
    slug: "silent-film",
    num: "34",
    en: "1920s Silent Film",
    cn: "1920s \u9ED8\u7247",
    category_en: "Cinema & Eras",
    category_cn: "\u7535\u5F71\u4E0E\u65F6\u4EE3",
    film: "The Runaway Loaf",
    line: "A baker's boy chases a runaway loaf downhill, then breaks it in half for a hungry girl.",
    line_cn: "\u9762\u5305\u5E97\u5B66\u5F92\u8FFD\u4E00\u4E2A\u6EDA\u8D70\u7684\u9762\u5305\uFF0C\u6700\u540E\u63B0\u6210\u4E24\u534A\u5206\u7ED9\u997F\u809A\u5B50\u7684\u5C0F\u5973\u5B69\u3002",
    uses: [
      "Comedy",
      "Retro brands",
      "Silent storytelling"
    ],
    demo_seconds: 54.2,
    three_js: false
  },
  {
    slug: "backrooms",
    num: "36",
    en: "Liminal Found Footage",
    cn: "\u540E\u5BA4 / \u65B0\u602A\u8C08",
    category_en: "Cinema & Eras",
    category_cn: "\u7535\u5F71\u4E0E\u65F6\u4EE3",
    film: "Night Shift Orientation",
    line: "A new night-shift hire films their first night in an endless yellow office, following the rules on the wall.",
    line_cn: "\u65B0\u591C\u73ED\u5458\u5DE5\u62CD\u4E0B\u5165\u804C\u7B2C\u4E00\u665A\uFF1A\u65E0\u5C3D\u7684\u9EC4\u8272\u529E\u516C\u7A7A\u95F4\uFF0C\u548C\u5899\u4E0A\u7684\u5458\u5DE5\u5B88\u5219\u3002",
    uses: [
      "Horror",
      "Mystery & ARG",
      "Game teasers"
    ],
    demo_seconds: 59.7,
    three_js: true
  },
  {
    slug: "brick-toy",
    num: "37",
    en: "Brick Toy",
    cn: "\u79EF\u6728\u73A9\u5177",
    category_en: "Materials & 3D",
    category_cn: "\u6750\u8D28\u4E0E 3D",
    film: "Rocket from Spare Parts",
    line: "A brick astronaut builds a rocket from spare parts and flies to a brick moon.",
    line_cn: "\u79EF\u6728\u5B87\u822A\u5458\u7528\u96F6\u4EF6\u62FC\u51FA\u706B\u7BAD\uFF0C\u98DE\u5411\u79EF\u6728\u6708\u4EAE\u3002",
    uses: [
      "Toys & kids",
      "Product builds",
      "Space"
    ],
    demo_seconds: 54,
    three_js: true
  },
  {
    slug: "paper-popup",
    num: "41",
    en: "Paper Pop-up Book",
    cn: "\u7EB8\u7247\u7ACB\u4F53\u4E66",
    category_en: "Materials & 3D",
    category_cn: "\u6750\u8D28\u4E0E 3D",
    film: "Pip's Paper Adventure",
    line: "A pop-up book opens on a desk; a sprite named Pip adventures through paper worlds and jumps out into ours.",
    line_cn: "\u7ACB\u4F53\u4E66\u5728\u4E66\u684C\u4E0A\u6253\u5F00\uFF0C\u5C0F\u7CBE\u7075 Pip \u5728\u7EB8\u7247\u4E16\u754C\u5192\u9669\uFF0C\u6700\u540E\u8DF3\u51FA\u4E66\u5916\u3002",
    uses: [
      "Children's books",
      "Game trailers",
      "Story films"
    ],
    demo_seconds: 133,
    three_js: true
  },
  {
    slug: "tilt-shift",
    num: "42",
    en: "Tilt-Shift Miniature",
    cn: "\u79FB\u8F74\u5FAE\u7F29",
    category_en: "Materials & 3D",
    category_cn: "\u6750\u8D28\u4E0E 3D",
    film: "Toy Town Rush Hour",
    line: "Morning rush hour in a town that looks like a model: traffic, trains and tiny people.",
    line_cn: "\u73A9\u5177\u57CE\u7684\u65E9\u9AD8\u5CF0\uFF0C\u4E00\u5207\u90FD\u50CF\u6A21\u578B\u3002",
    uses: [
      "City promos",
      "Real estate",
      "Transport"
    ],
    demo_seconds: 38,
    three_js: true
  },
  {
    slug: "lowpoly-island",
    num: "43",
    en: "Low-poly Isometric Island",
    cn: "\u4F4E\u591A\u8FB9\u5F62\u7B49\u8DDD",
    category_en: "Materials & 3D",
    category_cn: "\u6750\u8D28\u4E0E 3D",
    film: "The Island That Grew",
    line: "An island and its village grow tile by tile from an empty sea, each tile a note, into a starry night.",
    line_cn: "\u7A7A\u6D77\u91CC\u4E00\u683C\u683C\u957F\u51FA\u5C0F\u5C9B\u548C\u6751\u5E84\uFF0C\u6BCF\u653E\u4E00\u5757\u54CD\u4E00\u4E2A\u97F3\u7B26\uFF0C\u76F4\u5230\u661F\u7A7A\u3002",
    uses: [
      "Game trailers",
      "World building",
      "Calm content"
    ],
    demo_seconds: 53,
    three_js: true
  },
  {
    slug: "glass-product",
    num: "44",
    en: "Glass Product Render",
    cn: "\u73BB\u7483\u8D28\u611F\u4EA7\u54C1",
    category_en: "Materials & 3D",
    category_cn: "\u6750\u8D28\u4E0E 3D",
    film: "Aura \u2014 Hear the Light",
    line: "Unboxing and close-ups of Aura, fictional glass earbuds, in strip-light sweeps and caustics.",
    line_cn: "\u865A\u6784\u73BB\u7483\u8033\u673A Aura \u7684\u5F00\u7BB1\u4E0E\u7279\u5199\u3002",
    uses: [
      "Product launches",
      "Consumer tech",
      "Beauty"
    ],
    demo_seconds: 32,
    three_js: true
  },
  {
    slug: "urban-sketch",
    num: "45",
    en: "Urban Sketch \xB7 Pen & Wash",
    cn: "\u94A2\u7B14\u6DE1\u5F69",
    category_en: "Hand-drawn & Painting",
    category_cn: "\u624B\u7ED8\u4E0E\u7ED8\u753B",
    film: "Where the Wind Went",
    line: "A park that is only a pen sketch; wherever the wind carries her straw hat, colour follows.",
    line_cn: "\u516C\u56ED\u53EA\u662F\u4E00\u5F20\u94A2\u7B14\u901F\u5199\uFF0C\u98CE\u628A\u8349\u5E3D\u5439\u5230\u54EA\u91CC\uFF0C\u54EA\u91CC\u624D\u6709\u989C\u8272\u3002",
    uses: [
      "City & travel",
      "Architecture",
      "Lifestyle brands"
    ],
    demo_seconds: 32.4,
    three_js: false
  },
  {
    slug: "living-screencast",
    num: "46",
    en: "Living Screencast",
    cn: "\u6D3B\u4F53\u5B9E\u673A\u5F55\u5C4F",
    category_en: "Information & Keynote",
    category_cn: "\u4FE1\u606F\u4E0E\u53D1\u5E03",
    film: "Clawd Moves In",
    line: "Clawd hops out of the terminal into the Claude app and acts out plan mode and self-checks in one take.",
    line_cn: "\u50CF\u7D20\u5C0F\u4EBA Clawd \u642C\u8FDB Claude \u5E94\u7528\uFF0C\u4E00\u955C\u5230\u5E95\u6F14\u793A Plan \u6A21\u5F0F\u548C\u81EA\u68C0\u3002",
    uses: [
      "Product tutorials",
      "Feature launches",
      "Onboarding"
    ],
    demo_seconds: 59.4,
    three_js: false
  },
  {
    slug: "midcentury-toon",
    num: "48",
    en: "Mid-century Cartoon",
    cn: "50s \u6241\u5E73\u5361\u901A",
    category_en: "Cartoon & Anime",
    category_cn: "\u5361\u901A\u4E0E\u52A8\u753B",
    film: "Meet Pip",
    line: "A robot vacuum set up in three steps, told like a 1950s classroom film.",
    line_cn: "\u7528 50 \u5E74\u4EE3\u6559\u80B2\u7247\u7684\u53E3\u543B\uFF0C\u4E09\u6B65\u6559\u4F60\u88C5\u597D\u4E00\u53F0\u626B\u5730\u673A\u3002",
    uses: [
      "Set-up guides",
      "Help centres",
      "How-to"
    ],
    demo_seconds: 40,
    three_js: false
  },
  {
    slug: "hologram-hud",
    num: "52",
    en: "Sci-fi Hologram HUD",
    cn: "\u79D1\u5E7B\u5168\u606F\u754C\u9762",
    category_en: "Information & Keynote",
    category_cn: "\u4FE1\u606F\u4E0E\u53D1\u5E03",
    film: "Volt \xB7 Spec Scan",
    line: "An e-bike is scanned into a hologram; target boxes lock onto the battery, motor and brakes.",
    line_cn: "\u7535\u52A9\u529B\u8F66\u88AB\u626B\u63CF\u6210\u5168\u606F\u7EBF\u6846\uFF0C\u76EE\u6807\u6846\u4F9D\u6B21\u9501\u5B9A\u7535\u6C60\u3001\u7535\u673A\u3001\u5239\u8F66\u3002",
    uses: [
      "Spec walkthroughs",
      "Launch videos",
      "Trade shows"
    ],
    demo_seconds: 39,
    three_js: false
  },
  {
    slug: "engraving",
    num: "53",
    en: "Copperplate Engraving",
    cn: "\u94DC\u7248\u753B",
    category_en: "Print & Printmaking",
    category_cn: "\u5370\u5237\u4E0E\u7248\u753B",
    film: "The Honeybee, Plate VII",
    line: "A natural-history plate engraves itself: the burin cuts the copper, the bee builds up line by line, and a watercolour wash brings it to life.",
    line_cn: "\u4E00\u5F20\u535A\u7269\u5FD7\u56FE\u7248\u81EA\u5DF1\u523B\u51FA\u6765\uFF1A\u96D5\u5200\u63A8\u5F00\u94DC\u7248\uFF0C\u871C\u8702\u4E00\u7EBF\u7EBF\u6210\u5F62\uFF0C\u6700\u540E\u624B\u5DE5\u6C34\u5F69\u4E0A\u8272\u3002",
    uses: [
      "Museum labels",
      "Science explainers",
      "Brand heritage"
    ],
    demo_seconds: 40,
    three_js: false
  },
  {
    slug: "silkscreen-poster",
    num: "54",
    en: "Silkscreen Travel Poster",
    cn: "\u4E1D\u5370\u65C5\u884C\u6D77\u62A5",
    category_en: "Print & Printmaking",
    category_cn: "\u5370\u5237\u4E0E\u7248\u753B",
    film: "The Long Way Home",
    line: "A traveller crosses the world one full-bleed screen print at a time, a ticket stub counting the distance from home, until the far side turns into the way back.",
    line_cn: "\u4E00\u5F20\u6EE1\u5C4F\u4E1D\u5370\u6D77\u62A5\u4E00\u5EA7\u57CE\uFF0C\u7968\u6839\u6570\u7740\u79BB\u5BB6\u7684\u516C\u91CC\u6570\uFF0C\u8D70\u5230\u4E16\u754C\u7684\u53E6\u4E00\u5934\uFF0C\u624D\u53D1\u73B0\u90A3\u662F\u56DE\u5BB6\u7684\u8DEF\u3002",
    uses: [
      "Destination guides",
      "Tourism",
      "Event posters"
    ],
    demo_seconds: 50,
    three_js: false
  },
  {
    slug: "satellite-briefing",
    num: "55",
    en: "Satellite Briefing",
    cn: "\u536B\u661F\u7B80\u62A5",
    category_en: "Evidence Films",
    category_cn: "\u5B9E\u8BC1\u5F71\u50CF",
    film: "The Map Still Says Sea",
    line: "A satellite follows the map to the Aral Sea and finds a desert; only the part someone dammed came back.",
    line_cn: "\u536B\u661F\u7167\u7740\u5730\u56FE\u53BB\u627E\u54B8\u6D77\uFF0C\u627E\u5230\u7684\u662F\u6C99\u6F20\uFF1B\u53EA\u6709\u7B51\u4E86\u575D\u7684\u90A3\u4E00\u5757\u56DE\u6765\u4E86\u3002",
    uses: [
      "Climate",
      "News explainers",
      "Geography"
    ],
    demo_seconds: 37.8,
    three_js: false
  },
  {
    slug: "briefing-board",
    num: "56",
    en: "Engineering Briefing Board",
    cn: "\u5DE5\u7A0B\u7B80\u62A5\u677F",
    category_en: "Evidence Films",
    category_cn: "\u5B9E\u8BC1\u5F71\u50CF",
    film: "The Ship Decides",
    line: "Four bridge types are tested on one briefing wall, and the ship that must pass under picks the winner.",
    line_cn: "\u4E00\u6761\u6CB3\u8981\u67B6\u6865\uFF0C\u56DB\u79CD\u6865\u578B\u5728\u4E00\u9762\u7B80\u62A5\u5899\u4E0A\u9010\u4E2A\u53D7\u68C0\uFF0C\u62CD\u677F\u7684\u662F\u6865\u4E0B\u8981\u8FC7\u7684\u8239\u3002",
    uses: [
      "Engineering",
      "Option comparisons",
      "Briefings"
    ],
    demo_seconds: 40,
    three_js: false
  },
  {
    slug: "lidar-survey",
    num: "57",
    en: "LiDAR Survey",
    cn: "\u70B9\u4E91\u6D4B\u7ED8",
    category_en: "Evidence Films",
    category_cn: "\u5B9E\u8BC1\u5F71\u50CF",
    film: "The Fields Under the Forest",
    line: "A laser survey strips the canopy off a Connecticut forest and finds 3.4 km of old farm walls.",
    line_cn: "\u6FC0\u5149\u70B9\u4E91\u5265\u6389\u4E00\u7247\u68EE\u6797\u7684\u6811\u51A0\uFF0C\u9732\u51FA\u5F53\u5E74\u519C\u7530\u7684\u77F3\u5899\uFF1A3.4 \u516C\u91CC\u3002",
    uses: [
      "Heritage",
      "Environment",
      "Site surveys"
    ],
    demo_seconds: 40,
    three_js: true
  },
  {
    slug: "white-model",
    num: "58",
    en: "Projection on White Model",
    cn: "\u767D\u6A21\u6295\u5F71",
    category_en: "Evidence Films",
    category_cn: "\u5B9E\u8BC1\u5F71\u50CF",
    film: "How a Flattened City Grew Back",
    line: "A projector paints Rotterdam's white model layer by layer, from the 1940 gap to today's towers.",
    line_cn: "\u6295\u5F71\u673A\u628A\u6570\u636E\u4E00\u5C42\u5C42\u5237\u4E0A\u9E7F\u7279\u4E39\u767D\u6A21\uFF1A\u4ECE 1940 \u5E74\u7684\u7A7A\u6D1E\u5230\u4ECA\u5929\u7684\u5854\u697C\u3002",
    uses: [
      "Urban planning",
      "Exhibitions",
      "City data"
    ],
    demo_seconds: 40,
    three_js: true
  },
  {
    slug: "data-physical",
    num: "59",
    en: "Data Physicalization",
    cn: "\u6570\u636E\u5B9E\u7269\u5316",
    category_en: "Evidence Films",
    category_cn: "\u5B9E\u8BC1\u5F71\u50CF",
    film: "Two Spirals",
    line: "Twelve years of wind and solar stacked as real plates, spiralling round a walnut dial until solar overtakes.",
    line_cn: "\u5341\u4E8C\u5E74\u98CE\u7535\u548C\u592A\u9633\u80FD\u88C5\u673A\u53E0\u6210\u5B9E\u7269\uFF0C\u7ED5\u8868\u76D8\u5347\u6210\u4E24\u6761\u87BA\u65CB\uFF0C2021 \u5E74\u592A\u9633\u80FD\u53CD\u8D85\u3002",
    uses: [
      "Annual reports",
      "Investor decks",
      "Energy data"
    ],
    demo_seconds: 39.4,
    three_js: true
  },
  {
    slug: "teardown",
    num: "60",
    en: "Exploded Teardown",
    cn: "\u4EA7\u54C1\u62C6\u89E3",
    category_en: "Evidence Films",
    category_cn: "\u5B9E\u8BC1\u5F71\u50CF",
    film: "21 Keys, Opened",
    line: "Half an open-source keyboard comes apart in one orbit, down to the chip, then closes with its real dimensions.",
    line_cn: "\u5F00\u6E90\u952E\u76D8\u7684\u4E00\u534A\u5728\u4E00\u6B21\u73AF\u7ED5\u4E2D\u9010\u5C42\u62C6\u5F00\uFF0C\u770B\u5230\u4E3B\u63A7\u518D\u5408\u62E2\uFF0C\u6807\u4E0A\u771F\u5B9E\u5C3A\u5BF8\u3002",
    uses: [
      "Hardware launches",
      "Product pages",
      "Spec explainers"
    ],
    demo_seconds: 38.8,
    three_js: true
  },
  {
    slug: "microscope",
    num: "61",
    en: "Microscope Story",
    cn: "\u663E\u5FAE\u53D9\u4E8B",
    category_en: "Evidence Films",
    category_cn: "\u5B9E\u8BC1\u5F71\u50CF",
    film: "Measured Blue",
    line: "One continuous move from a liver slide to a single nucleus; two circles, counted pixel by pixel, differ 2.4 times in blue.",
    line_cn: "\u4E00\u955C\u4ECE\u809D\u7EC4\u7EC7\u73BB\u7247\u63A8\u5230\u5355\u4E2A\u7EC6\u80DE\u6838\uFF0C\u4E24\u4E2A\u5706\u9010\u50CF\u7D20\u6570\u51FA 2.4 \u500D\u7684\u84DD\u3002",
    uses: [
      "Biomedicine",
      "Materials science",
      "Skincare science"
    ],
    demo_seconds: 39.5,
    three_js: false
  },
  {
    slug: "archive-lighttable",
    num: "62",
    en: "Archive Light Table",
    cn: "\u6863\u6848\u706F\u53F0",
    category_en: "Evidence Films",
    category_cn: "\u5B9E\u8BC1\u5F71\u50CF",
    film: "Two Seconds Short",
    line: "The telegram said 57 seconds; under a loupe, the Wrights' glass negatives and the archive say 59.",
    line_cn: "\u7535\u62A5\u8BF4\u6700\u957F\u98DE\u4E86 57 \u79D2\uFF1B\u653E\u5927\u955C\u4E0B\uFF0C\u83B1\u7279\u5144\u5F1F\u7684\u5E95\u7247\u548C\u6863\u6848\u8BF4\u662F 59 \u79D2\u3002",
    uses: [
      "Brand history",
      "Archive stories",
      "Museums"
    ],
    demo_seconds: 40,
    three_js: false
  },
  {
    slug: "caption-news",
    num: "63",
    en: "Caption News",
    cn: "\u5B57\u5E55\u65B0\u95FB",
    category_en: "Edit & Documentary",
    category_cn: "\u526A\u8F91\u4E0E\u7EAA\u5B9E",
    film: "The Bee Ledger",
    line: "America lost 1.3 million bee colonies, yet the count rose 6 %: a news short that works with the sound off.",
    line_cn: "\u7F8E\u56FD\u4E00\u5E74\u6B7B\u6389 130 \u4E07\u7BB1\u871C\u8702\uFF0C\u603B\u6570\u5374\u6DA8\u4E86 6%\uFF1A\u9759\u97F3\u4E5F\u80FD\u770B\u61C2\u7684\u65B0\u95FB\u3002",
    uses: [
      "Social news",
      "Report explainers",
      "Data shorts"
    ],
    demo_seconds: 59.5,
    three_js: false
  },
  {
    slug: "newsreel",
    num: "64",
    en: "1920s Newsreel",
    cn: "1920s \u65B0\u95FB\u5F71\u7247",
    category_en: "Edit & Documentary",
    category_cn: "\u526A\u8F91\u4E0E\u7EAA\u5B9E",
    film: "Knock-Knee Alert",
    line: "1926: the papers say the Charleston will ruin America's knees; at Ford's own picnic the kids dance it anyway.",
    line_cn: "1926 \u5E74\u62A5\u7EB8\u8BF4\u67E5\u5C14\u65AF\u987F\u4F1A\u8DF3\u574F\u819D\u76D6\uFF0C\u798F\u7279\u5DE5\u4EBA\u91CE\u9910\u4F1A\u4E0A\u7684\u5B69\u5B50\u7167\u8DF3\u4E0D\u8BEF\u3002",
    uses: [
      "History stories",
      "Fads & eras",
      "Anniversaries"
    ],
    demo_seconds: 54.6,
    three_js: false
  },
  {
    slug: "countdown",
    num: "65",
    en: "Live Countdown Split-screen",
    cn: "\u5B9E\u65F6\u5012\u8BA1\u65F6\u5206\u5C4F",
    category_en: "Edit & Documentary",
    category_cn: "\u526A\u8F91\u4E0E\u7EAA\u5B9E",
    film: "Counting Itself Down",
    line: "The last minute of the Artemis II launch, uncut: one cell opens to nine, and they merge into one at ignition.",
    line_cn: "\u963F\u5C14\u5FD2\u5F25\u65AF\u4E8C\u53F7\u53D1\u5C04\u7684\u6700\u540E\u4E00\u5206\u949F\uFF0C\u4E00\u79D2\u4E0D\u526A\uFF1A\u683C\u5B50\u4ECE 1 \u5F00\u5230 9\uFF0C\u70B9\u706B\u5408\u6210 1\u3002",
    uses: [
      "Launches",
      "Countdowns",
      "Live events"
    ],
    demo_seconds: 59.5,
    three_js: false
  },
  {
    slug: "city-symphony",
    num: "66",
    en: "Time-lapse Symphony",
    cn: "\u5EF6\u65F6\u4EA4\u54CD",
    category_en: "Edit & Documentary",
    category_cn: "\u526A\u8F91\u4E0E\u7EAA\u5B9E",
    film: "One Day in New York",
    line: "One day in New York in time-lapse: rivers of light, a grid on the sixteenths, 1899 beside today.",
    line_cn: "\u7EBD\u7EA6\u7684\u4E00\u5929\uFF1A\u5EF6\u65F6\u5149\u6CB3\u3001\u8E29\u7740\u5341\u516D\u5206\u97F3\u7B26\u7684\u7F51\u683C\uFF0C1899 \u5E74\u548C\u4ECA\u5929\u5E76\u6392\u3002",
    uses: [
      "City films",
      "Music montages",
      "Openers"
    ],
    demo_seconds: 52,
    three_js: false
  },
  {
    slug: "visual-investigation",
    num: "67",
    en: "Visual Investigation",
    cn: "\u89C6\u89C9\u8C03\u67E5",
    category_en: "Edit & Documentary",
    category_cn: "\u526A\u8F91\u4E0E\u7EAA\u5B9E",
    film: "The Hindenburg: Four Minutes, 32 Seconds",
    line: "Newsreel, photos, testimony and the 1937 inquiry on one clock: five sources point to the same spot.",
    line_cn: "\u65B0\u95FB\u7247\u3001\u7167\u7247\u3001\u8BC1\u8BCD\u548C\u8C03\u67E5\u62A5\u544A\u6392\u4E0A\u540C\u4E00\u6761\u65F6\u95F4\u8F74\uFF0C\u4E94\u8DEF\u6765\u6E90\u6307\u5411\u4E00\u5904\u3002",
    uses: [
      "Reconstructions",
      "Fact-checks",
      "Incident reports"
    ],
    demo_seconds: 60,
    three_js: false
  },
  {
    slug: "kino-montage",
    num: "68",
    en: "Constructivist Montage",
    cn: "\u6784\u6210\u4E3B\u4E49\u8499\u592A\u5947",
    category_en: "Edit & Documentary",
    category_cn: "\u526A\u8F91\u4E0E\u7EAA\u5B9E",
    film: "410 Days",
    line: "The Empire State's 1931 brochure credits its builders; the site film and Hine's photos answer: 2,500 a day.",
    line_cn: "\u5E1D\u56FD\u5927\u53A6\u7684\u5C0F\u518C\u5B50\u5199\u7740\u5EFA\u9020\u8005\uFF0C\u5DE5\u5730\u5B9E\u62CD\u548C\u8001\u7167\u7247\u7ED9\u51FA\u7B54\u6848\uFF1A\u6BCF\u5929 2,500 \u4EBA\u3002",
    uses: [
      "Industry histories",
      "Milestones",
      "Collective effort"
    ],
    demo_seconds: 60,
    three_js: false
  },
  {
    slug: "telestrator",
    num: "69",
    en: "Sports Telestrator",
    cn: "\u4F53\u80B2\u6218\u672F\u677F",
    category_en: "Edit & Documentary",
    category_cn: "\u526A\u8F91\u4E0E\u7EAA\u5B9E",
    film: "Freeze Frame",
    line: "Down 3\u20130 at half-time, Fenerbah\xE7e scored three in 12 minutes: freeze, draw, split screen, shot map.",
    line_cn: "\u534A\u573A 0\u20133\uFF0C\u8D39\u5185\u5DF4\u5207 12 \u5206\u949F\u8FDE\u8FDB\u4E09\u7403\uFF1A\u51BB\u4F4F\u753B\u9762\u3001\u753B\u7EBF\u3001\u5206\u5C4F\u3001\u5C04\u95E8\u56FE\u3002",
    uses: [
      "Sports analysis",
      "Match recaps",
      "Coaching"
    ],
    demo_seconds: 54.4,
    three_js: false
  },
  {
    slug: "news-package",
    num: "70",
    en: "Broadcast News Package",
    cn: "\u7535\u89C6\u65B0\u95FB\u5305\u88C5",
    category_en: "Edit & Documentary",
    category_cn: "\u526A\u8F91\u4E0E\u7EAA\u5B9E",
    film: "The Week in AI",
    line: "Four AI stories from one week in a full on-air package: rundown, headline strap, price board, spec card.",
    line_cn: "\u4E00\u5468\u56DB\u6761 AI \u65B0\u95FB\uFF0C\u4E00\u6574\u5957\u7535\u89C6\u53F0\u5305\u88C5\uFF1A\u4E32\u8054\u5355\u3001\u6807\u9898\u6761\u3001\u7FFB\u724C\u4EF7\u683C\u8868\u3001\u89C4\u683C\u5361\u3002",
    uses: [
      "News round-ups",
      "Bulletins",
      "Market updates"
    ],
    demo_seconds: 53.5,
    three_js: false
  },
  {
    slug: "memphis-diorama",
    num: "71",
    en: "Memphis Diorama",
    cn: "\u5B5F\u83F2\u65AF\u5FAE\u7F29\u666F\u89C2",
    category_en: "Materials & 3D",
    category_cn: "\u6750\u8D28\u4E0E 3D",
    film: "Four Seasons in Pomelo Town",
    line: "One river bend, four seasons, one take; each turns when the big tree squats and springs back.",
    line_cn: "\u4E00\u4E2A\u6CB3\u6E7E\u4E00\u955C\u8FC7\u5B8C\u56DB\u5B63\uFF0C\u5927\u6811\u4E00\u8E72\u4E00\u5F39\uFF0C\u5C31\u6362\u4E00\u5B63\u3002",
    uses: [
      "Web heroes",
      "Ambient loops",
      "Seasons"
    ],
    demo_seconds: 45,
    three_js: true
  },
  {
    slug: "transit-map",
    num: "72",
    en: "Transit Map",
    cn: "\u5730\u94C1\u7EBF\u8DEF\u56FE",
    category_en: "Information & Keynote",
    category_cn: "\u4FE1\u606F\u4E0E\u53D1\u5E03",
    film: "6 Kilometres",
    line: "A printed metro map grows from one 6 km line in 1993 to 21 lines and 906 km.",
    line_cn: "\u4E00\u5F20\u7EB8\u4E0A\u7684\u7EBF\u8DEF\u56FE\uFF0C\u4ECE 1993 \u5E74\u7684 6 \u516C\u91CC\u957F\u5230 21 \u6761\u7EBF\u3001906 \u516C\u91CC\u3002",
    uses: [
      "Transport",
      "Growth over time",
      "Networks"
    ],
    demo_seconds: 47,
    three_js: false
  },
  {
    slug: "chalkboard",
    num: "73",
    en: "Chalkboard",
    cn: "\u9ED1\u677F\u7C89\u7B14",
    category_en: "Hand-drawn & Painting",
    category_cn: "\u624B\u7ED8\u4E0E\u7ED8\u753B",
    film: "The Story of Chinese Characters",
    line: "Chalk writes a popular claim about two characters, wipes it, and traces \u5C04 back three thousand years.",
    line_cn: "\u7C89\u7B14\u5199\u4E0B\u7F51\u4E0A\u7684\u8BF4\u6CD5\uFF0C\u518D\u4E00\u64E6\uFF0C\u628A\u300C\u5C04\u300D\u5199\u56DE\u4E09\u5343\u5E74\u524D\u3002",
    uses: [
      "Word origins",
      "Myth-busting",
      "Lessons"
    ],
    demo_seconds: 49.3,
    three_js: false
  },
  {
    slug: "isometric-picture-book",
    num: "74",
    en: "Isometric Picture Book",
    cn: "\u7B49\u8DDD\u7ED8\u672C",
    category_en: "Information & Keynote",
    category_cn: "\u4FE1\u606F\u4E0E\u53D1\u5E03",
    film: "Seventy-Two Seats",
    line: "Travellers board an isometric plane, and the order shows why one way is nearly twice as fast.",
    line_cn: "\u7B49\u8DDD\u7684\u767B\u673A\u53E3\u548C\u673A\u8231\u91CC\uFF0C\u5C0F\u4EBA\u6309\u987A\u5E8F\u767B\u673A\uFF0C\u8BB2\u6E05\u54EA\u79CD\u53EB\u6CD5\u5FEB\u5C06\u8FD1\u4E00\u534A\u3002",
    uses: [
      "Everyday rules",
      "Queues",
      "Comparisons"
    ],
    demo_seconds: 59.8,
    three_js: false
  },
  {
    slug: "printed-long-take",
    num: "75",
    en: "Printed Long Take",
    cn: "\u5370\u5237\u957F\u955C\u5934",
    category_en: "Print & Printmaking",
    category_cn: "\u5370\u5237\u4E0E\u7248\u753B",
    film: "Thirty-Three Cranes",
    line: "Red-crowned cranes in a Hokkaido valley, one scratchboard take, counted back from 33 to 1,927.",
    line_cn: "\u522E\u7248\u753B\u7684\u5317\u6D77\u9053\u6CB3\u8C37\u4E00\u955C\u5230\u5E95\uFF0C\u4E39\u9876\u9E64\u4ECE 33 \u53EA\u6570\u56DE\u5230 1,927 \u53EA\u3002",
    uses: [
      "Journeys",
      "Wildlife",
      "Landscapes"
    ],
    demo_seconds: 60,
    three_js: true
  },
  {
    slug: "circuit-board",
    num: "76",
    en: "Circuit Board",
    cn: "\u7535\u8DEF\u677F",
    category_en: "Information & Keynote",
    category_cn: "\u4FE1\u606F\u4E0E\u53D1\u5E03",
    film: "Seven Milliseconds",
    line: "Rivers become copper traces as current runs 2,080 km from a dam to a phone charger.",
    line_cn: "\u6C5F\u6CB3\u53D8\u6210\u7535\u8DEF\u677F\u4E0A\u7684\u8D70\u7EBF\uFF0C\u7535\u6D41\u4ECE\u6C34\u575D\u8DD1 2,080 \u516C\u91CC\u8FDB\u624B\u673A\u5145\u7535\u5668\u3002",
    uses: [
      "Energy",
      "Supply chains",
      "Devices"
    ],
    demo_seconds: 60,
    three_js: false
  },
  {
    slug: "desktop-flythrough",
    num: "77",
    en: "Desktop Flythrough",
    cn: "\u684C\u9762\u7A7F\u68AD",
    category_en: "Materials & 3D",
    category_cn: "\u6750\u8D28\u4E0E 3D",
    film: "Before the Ding",
    line: "A cat photo hops across app cards on a sunlit desk, from one phone to a friend's.",
    line_cn: "\u4E00\u5F20\u732B\u7167\u7247\u8DF3\u8FC7\u684C\u4E0A\u7684\u5E94\u7528\u5361\u7247\uFF0C\u4ECE\u4E00\u53F0\u624B\u673A\u98DE\u5230\u670B\u53CB\u624B\u673A\u91CC\uFF0C\u4E00\u955C\u8DDF\u5230\u5E95\u3002",
    uses: [
      "App explainers",
      "Workflows",
      "Products"
    ],
    demo_seconds: 60,
    three_js: true
  }
];

// ../engine/src/filmstyle/lemo/lemo.ts
var SourceID = "lemo-opuscar";
var RepoURL = "https://github.com/lemomo-ai/lemo-opuscar.git";
var Gallery = "https://lemomo-ai.github.io/lemo-opuscar/";
var PinnedCommit = "bebbbe1aa92a3cb4bb6f83500e61b23a17d1aa00";
var PinnedStyleCount = 66;
var LibraryEnv = "AM_LEMO_OPUSCAR_LIBRARY";
function entryLabel(entry) {
  return `${entry.cn} ${entry.en}\uFF08${SourceID}/${entry.slug}\uFF09`;
}
function entryStyle(entry) {
  const style3 = {
    source: SourceID,
    slug: entry.slug,
    order: entry.num,
    cn: entry.cn,
    en: entry.en,
    category_cn: entry.category_cn,
    category_en: entry.category_en,
    uses: entry.uses,
    summary: "demo\uFF1A" + entry.line_cn
  };
  if (entry.three_js) style3.tags = ["three.js"];
  return style3;
}
var catalogEntries = catalog_default;
function catalog2() {
  return catalogEntries.map((entry) => ({ ...entry, uses: entry.uses ? [...entry.uses] : entry.uses }));
}
function find2(slug) {
  const entry = catalogEntries.find((e) => e.slug === slug);
  return entry ? { ...entry } : void 0;
}

// ../engine/src/filmstyle/lemo/library.ts
var import_node_child_process2 = require("node:child_process");
var import_node_fs7 = __toESM(require("node:fs"), 1);
var import_node_path8 = __toESM(require("node:path"), 1);
function repoOf(opts) {
  return opts.repoURL || RepoURL;
}
function commitOf(opts) {
  return opts.commit || PinnedCommit;
}
function errorText3(err) {
  const e = err;
  if (e && typeof e === "object" && typeof e.code === "string" && typeof e.path === "string" && typeof e.syscall === "string") {
    return goPathError(e.syscall, e.path, e);
  }
  return err instanceof Error ? err.message : String(err);
}
function defaultLibraryDir(env, commit) {
  if (commit.length > 12) commit = commit.slice(0, 12);
  return import_node_path8.default.join(sourceDir(env, SourceID), commit);
}
function libraryDir(opts) {
  const dir = opts.env[LibraryEnv];
  if (dir) return dir;
  return defaultLibraryDir(opts.env, commitOf(opts));
}
function exists3(file) {
  try {
    import_node_fs7.default.statSync(file);
    return true;
  } catch {
    return false;
  }
}
function isLibrary(dir) {
  return ["core/lib.js", "styles"].every((rel) => exists3(import_node_path8.default.join(dir, rel)));
}
var LibraryNotFoundError = class extends Error {
  constructor(dir) {
    super(`\u98CE\u683C\u5E93 ${dir} \u8FD8\u6CA1\u6709\u4E0B\u8F7D\uFF1Afile does not exist`);
    this.dir = dir;
    this.name = "LibraryNotFoundError";
  }
  dir;
  code = "ENOENT";
};
function lookGit(env) {
  try {
    return lookPath("git", env.PATH ?? "");
  } catch {
    return void 0;
  }
}
function openLibrary(opts) {
  const dir = libraryDir(opts);
  if (!isLibrary(dir)) throw new LibraryNotFoundError(dir);
  const lib = { dir, commit: "", managed: exists3(import_node_path8.default.join(dir, managedMarker)) };
  const git = lookGit(opts.env);
  if (git !== void 0) {
    const result = (0, import_node_child_process2.spawnSync)(git, ["rev-parse", "HEAD"], { cwd: dir, env: gitEnv(opts.env), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    if (result.status === 0 && !result.error) lib.commit = result.stdout.trim();
  }
  return lib;
}
async function ensureLibrary(opts, signal) {
  try {
    return openLibrary(opts);
  } catch {
  }
  const dir = libraryDir(opts);
  let entries = [];
  try {
    entries = import_node_fs7.default.readdirSync(dir);
  } catch {
  }
  if (entries.length > 0) throw new Error(`${dir} \u4E0D\u662F lemo-opuscar \u98CE\u683C\u5E93\uFF08\u7F3A\u5C11 core/lib.js \u6216 styles/\uFF09`);
  let git;
  try {
    git = lookPath("git", opts.env.PATH ?? "");
  } catch (err) {
    throw new Error(`\u627E\u4E0D\u5230 git\uFF0C\u65E0\u6CD5\u4E0B\u8F7D\u98CE\u683C\u5E93\uFF1A${errorText3(err)}`, { cause: err });
  }
  import_node_fs7.default.mkdirSync(import_node_path8.default.dirname(dir), { recursive: true });
  const unlock = await lock(dir + ".lock", signal);
  try {
    try {
      return openLibrary(opts);
    } catch {
    }
    const partial = dir + ".partial";
    const commit = commitOf(opts);
    try {
      await downloadLibrary(git, partial, commit, opts, signal);
    } catch (err) {
      throw new Error(
        `${errorText3(err)}
\u5DF2\u4E0B\u8F7D\u7684\u90E8\u5206\u4FDD\u7559\u5728 ${partial}\uFF0C\u518D\u8FD0\u884C\u4E00\u6B21\u4F1A\u63A5\u7740\u4E0B\u8F7D\uFF1B\u4E5F\u53EF\u4EE5\u81EA\u5DF1 git clone ${repoOf(opts).replace(/\.git$/, "")} \u540E\u7528 ${LibraryEnv} \u6307\u5411\u5B83`,
        { cause: err }
      );
    }
    import_node_fs7.default.writeFileSync(import_node_path8.default.join(partial, managedMarker), commit + "\n", { mode: 420 });
    try {
      import_node_fs7.default.rmdirSync(dir);
    } catch {
    }
    try {
      import_node_fs7.default.renameSync(partial, dir);
    } catch (err) {
      throw new Error(`\u653E\u7F6E\u98CE\u683C\u5E93\u5230 ${dir}\uFF1Arename ${partial} ${dir}: ${errorText3(err)}`, { cause: err });
    }
    return { dir, commit, managed: true };
  } finally {
    unlock();
  }
}
var librarySparse = [
  "/*",
  "!/styles/*/demo/",
  "!/styles/*/poster.jpg",
  "!/styleboard/",
  "!/docs/",
  "!/core/assets/"
];
var libraryStages = [
  ["/*", "!/*/"],
  ["/*", "!/*/", "/core/", "!/core/assets/"],
  ["/*", "!/*/", "/core/", "!/core/assets/", "/styles/*/STYLE.md", "/styles/*/style.json", "/styles/*/DEMO.md"],
  librarySparse
];
var stageAttempts = 5;
async function downloadLibrary(git, partial, commit, opts, signal) {
  const run2 = (...args) => gitCommand(git, partial, opts.env, opts.output, args, signal);
  const retry = async (what, ...args) => {
    let last;
    for (let attempt = 1; attempt <= stageAttempts; attempt++) {
      try {
        await run2(...args);
        return;
      } catch (err) {
        last = err;
      }
      if (signal?.aborted) throw abortReason(signal);
      if (opts.output && attempt < stageAttempts) opts.output.write(`${what}\u5931\u8D25\uFF0C\u91CD\u8BD5\uFF08${attempt + 1}/${stageAttempts}\uFF09\u2026
`);
    }
    throw new Error(`${what}\u5931\u8D25\uFF1A${errorText3(last)}`, { cause: last });
  };
  if (!exists3(import_node_path8.default.join(partial, ".git"))) {
    import_node_fs7.default.rmSync(partial, { recursive: true, force: true });
    import_node_fs7.default.mkdirSync(partial, { recursive: true });
    for (const step of [
      ["init", "--quiet"],
      ["remote", "add", "origin", repoOf(opts)],
      ["config", "core.sparseCheckout", "true"]
    ]) {
      try {
        await run2(...step);
      } catch (err) {
        throw new Error(`\u51C6\u5907\u98CE\u683C\u5E93\u514B\u9686\uFF08git ${step.join(" ")}\uFF09\uFF1A${errorText3(err)}`, { cause: err });
      }
    }
  } else {
    try {
      await run2("remote", "set-url", "origin", repoOf(opts));
    } catch (err) {
      throw new Error(`\u66F4\u65B0\u98CE\u683C\u5E93\u7684\u4E0A\u6E38\u5730\u5740\uFF1A${errorText3(err)}`, { cause: err });
    }
  }
  let haveCommit = true;
  try {
    await run2("rev-parse", "--verify", "--quiet", commit + "^{commit}");
  } catch {
    haveCommit = false;
  }
  if (!haveCommit) {
    await retry("\u4ECE " + repoOf(opts) + " \u4E0B\u8F7D\u98CE\u683C\u5E93 " + commit + " ", "fetch", "--quiet", "--depth", "1", "--filter=blob:none", "origin", commit);
  }
  let head = "";
  try {
    head = await run2("rev-parse", "--verify", "--quiet", "HEAD");
  } catch {
    head = "";
  }
  if (head !== commit) {
    writeSparse(partial, libraryStages[0]);
    await retry("\u68C0\u51FA\u98CE\u683C\u5E93", "-c", "advice.detachedHead=false", "checkout", "--quiet", "--force", commit);
  }
  const stages = libraryStages;
  for (let i = 0; i < stages.length; i++) {
    writeSparse(partial, stages[i]);
    await retry(`\u68C0\u51FA\u98CE\u683C\u5E93\uFF08\u7B2C ${i + 1}/${stages.length} \u6BB5\uFF09`, "read-tree", "--reset", "-u", "HEAD");
  }
  const finalHead = await run2("rev-parse", "HEAD");
  if (finalHead !== commit) throw new Error(`\u98CE\u683C\u5E93\u68C0\u51FA\u5230 ${finalHead}\uFF0C\u4E0E\u56FA\u5B9A\u7684 ${commit} \u4E0D\u7B26\uFF0C\u62D2\u7EDD\u4F7F\u7528`);
  if (!isLibrary(partial)) throw new Error(`\u98CE\u683C\u5E93 ${commit} \u4E0A\u7F3A\u5C11 core/lib.js \u6216 styles/\uFF1A\u4E0A\u6E38\u76EE\u5F55\u7ED3\u6784\u5DF2\u53D8`);
}
var managedMarker = ".am-library";
function writeSparse(dir, patterns) {
  const info = import_node_path8.default.join(dir, ".git", "info");
  import_node_fs7.default.mkdirSync(info, { recursive: true });
  import_node_fs7.default.writeFileSync(import_node_path8.default.join(info, "sparse-checkout"), patterns.join("\n") + "\n", { mode: 420 });
}
function readSparse(dir) {
  const body = import_node_fs7.default.readFileSync(import_node_path8.default.join(dir, ".git", "info", "sparse-checkout"), "utf8");
  return body.split("\n").map((line2) => line2.trim()).filter((line2) => line2 !== "");
}
var skipInDemo = /* @__PURE__ */ new Set(["stills", "out", "chk", "node_modules"]);
function sortedEntries2(dir) {
  return import_node_fs7.default.readdirSync(dir, { withFileTypes: true }).sort((a, b) => compareBytes(a.name, b.name));
}
function demoUsesCoreAssets(demo) {
  const walk = (dir) => {
    let entries;
    try {
      entries = sortedEntries2(dir);
    } catch {
      return false;
    }
    for (const entry of entries) {
      const file = import_node_path8.default.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skipInDemo.has(entry.name)) continue;
        if (walk(file)) return true;
        continue;
      }
      switch (goExt(file).toLowerCase()) {
        case ".js":
        case ".mjs":
        case ".html":
        case ".json":
          break;
        default:
          continue;
      }
      try {
        if (import_node_fs7.default.readFileSync(file, "utf8").includes("core/assets/")) return true;
      } catch {
      }
    }
    return false;
  };
  let root;
  try {
    root = import_node_fs7.default.lstatSync(demo);
  } catch {
    return false;
  }
  if (!root.isDirectory()) return false;
  if (skipInDemo.has(import_node_path8.default.basename(demo))) return false;
  return walk(demo);
}
function gitCommand(git, dir, env, stderr, args, signal) {
  return runCommand2(git, args, { cwd: dir, env: gitEnv(env), stderr, signal }).then((out) => out.trim());
}
function runCommand2(file, args, options = {}) {
  const { signal } = options;
  return new Promise((resolve3, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const child = (0, import_node_child_process2.spawn)(file, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", options.stderr ? "pipe" : "ignore"]
    });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (options.stdout) options.stdout.write(chunk);
      else out += chunk;
    });
    if (options.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => options.stderr.write(chunk));
    }
    const onAbort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", onAbort, { once: true });
    let failed = false;
    child.once("error", (err) => {
      failed = true;
      signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code, sig) => {
      signal?.removeEventListener("abort", onAbort);
      if (failed) return;
      if (signal?.aborted) reject(abortReason(signal));
      else if (sig) reject(new ExitError(-1, sig));
      else if (code !== 0) reject(new ExitError(code ?? -1, null));
      else resolve3(out);
    });
  });
}
function gitEnv(env) {
  const out = { ...env };
  out.GIT_LFS_SKIP_SMUDGE = "1";
  out.GIT_CONFIG_GLOBAL = "/dev/null";
  out.GIT_CONFIG_SYSTEM = "/dev/null";
  out.GIT_TERMINAL_PROMPT = "0";
  if (!out.GIT_HTTP_LOW_SPEED_LIMIT) out.GIT_HTTP_LOW_SPEED_LIMIT = "1000";
  if (!out.GIT_HTTP_LOW_SPEED_TIME) out.GIT_HTTP_LOW_SPEED_TIME = "60";
  return out;
}
var lockStale2 = 30 * 60 * 1e3;
async function lock(file, signal) {
  for (; ; ) {
    try {
      const fd = import_node_fs7.default.openSync(file, "wx", 420);
      import_node_fs7.default.writeSync(fd, `${process.pid}
`);
      import_node_fs7.default.closeSync(fd);
      return () => {
        try {
          import_node_fs7.default.unlinkSync(file);
        } catch {
        }
      };
    } catch (err) {
      if (err.code !== "EEXIST") {
        throw new Error(`\u521B\u5EFA\u9501 ${file}\uFF1A${goPathError("open", file, err)}`, { cause: err });
      }
    }
    try {
      if (Date.now() - import_node_fs7.default.statSync(file).mtimeMs > lockStale2) {
        import_node_fs7.default.rmSync(file, { force: true });
        continue;
      }
    } catch {
    }
    if (signal?.aborted) throw abortReason(signal);
    await new Promise((resolve3, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve3();
      }, 200);
      const onAbort = () => {
        clearTimeout(timer);
        reject(abortReason(signal));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}
function posterPath(lib, slug) {
  return import_node_path8.default.join(lib.dir, "styles", slug, "poster.jpg");
}

// ../engine/src/filmstyle/lemo/prepare.ts
var import_node_crypto4 = __toESM(require("node:crypto"), 1);
var import_node_fs8 = __toESM(require("node:fs"), 1);
var import_node_path9 = __toESM(require("node:path"), 1);
var completeMarker = "am-complete";
var fullSparse = ["/*", "!/styleboard/", "!/docs/"];
var demoBatch = 10;
function libraryComplete(lib) {
  if (lib.managed) return exists3(import_node_path9.default.join(lib.dir, ".git", completeMarker));
  const entries = catalog2();
  if (entries.length === 0) return false;
  const first = entries[0].slug;
  return exists3(import_node_path9.default.join(lib.dir, "styles", first, "demo", "index.html")) && exists3(posterPath(lib, first));
}
function requireLibrary(opts) {
  let lib;
  try {
    lib = openLibrary(opts);
  } catch {
    throw missing("lemo-opuscar \u98CE\u683C\u5E93", "\u6CA1\u6709\u4E0B\u8F7D\u5230 " + libraryDir(opts));
  }
  if (!libraryComplete(lib)) throw missing("lemo-opuscar \u98CE\u683C\u5E93", lib.dir + " \u8FD8\u6CA1\u4E0B\u8F7D\u5B8C\u6574");
  return lib;
}
function requireStyle(lib, style3) {
  if (!exists3(import_node_path9.default.join(lib.dir, "styles", style3.slug, "demo", "index.html"))) {
    throw missing("\u98CE\u683C " + entryLabel(style3) + " \u7684 demo \u6E90\u7801", "\u98CE\u683C\u5E93 " + lib.dir + " \u91CC\u6CA1\u6709");
  }
  if (style3.three_js && !exists3(import_node_path9.default.join(lib.dir, "node_modules", "three", "build", "three.module.js"))) {
    throw missing("\u98CE\u683C\u5E93\u7684 three.js \u4F9D\u8D56", entryLabel(style3) + " \u8981\u7528\uFF0C\u98CE\u683C\u5E93\u91CC\u8FD8\u6CA1\u6709 node_modules/three");
  }
}
async function prepareLibrary(opts, signal) {
  const report = opts.progress ?? (() => {
  });
  try {
    const existing = openLibrary(opts);
    if (libraryComplete(existing)) return existing;
  } catch {
  }
  const entries = catalog2();
  const batches = Math.floor((entries.length + demoBatch - 1) / demoBatch);
  const steps = 1 + 1 + batches + 1 + 1;
  let step = 0;
  const next = (stage) => {
    step++;
    report({ step, steps, stage });
  };
  next("\u4E0B\u8F7D\u98CE\u683C\u5E93\u57FA\u7840\u90E8\u5206\uFF08\u6307\u5357\u3001core/\u3001\u5168\u90E8\u98CE\u683C\u8BF4\u660E\uFF09");
  const lib = await ensureLibrary(opts, signal);
  if (!lib.managed) {
    if (!libraryComplete(lib)) {
      throw new Error(`${lib.dir} \u662F\u4F60\u81EA\u5DF1\u7684\u68C0\u51FA\uFF0Cam \u4E0D\u6539\u5B83\uFF1A\u8BF7\u5728\u91CC\u9762\u68C0\u51FA\u5168\u90E8 demo \u4E0E\u6D77\u62A5\uFF08styles/*/demo\u3001styles/*/poster.jpg\uFF09`);
    }
    return lib;
  }
  let git;
  try {
    git = lookPath("git", opts.env.PATH ?? "");
  } catch (err) {
    throw new Error(`\u627E\u4E0D\u5230 git\uFF0C\u65E0\u6CD5\u4E0B\u8F7D\u98CE\u683C\u5E93\uFF1A${errorText3(err)}`, { cause: err });
  }
  const unlock = await lock(lib.dir + ".lock", signal);
  try {
    let patterns;
    try {
      patterns = readSparse(lib.dir);
    } catch (err) {
      throw new Error(`\u8BFB\u53D6\u98CE\u683C\u5E93\u7A00\u758F\u89C4\u5219\uFF1A${errorText3(err)}`, { cause: err });
    }
    const stage = async (what, ...add) => {
      for (const pattern of add) {
        if (!patterns.includes(pattern)) patterns.push(pattern);
      }
      writeSparse(lib.dir, patterns);
      let readErr;
      for (let attempt = 1; attempt <= stageAttempts; attempt++) {
        try {
          await gitCommand(git, lib.dir, opts.env, opts.output, ["read-tree", "--reset", "-u", "HEAD"], signal);
          readErr = void 0;
          break;
        } catch (err) {
          readErr = err;
        }
        if (signal?.aborted) break;
        if (opts.output && attempt < stageAttempts) opts.output.write(`${what}\u5931\u8D25\uFF0C\u91CD\u8BD5\uFF08${attempt + 1}/${stageAttempts}\uFF09\u2026
`);
      }
      if (readErr !== void 0) {
        throw new Error(`${what}\u5931\u8D25\uFF08\u518D\u8FD0\u884C\u4E00\u6B21\u4F1A\u63A5\u7740\u4E0B\u8F7D\uFF09\uFF1A${errorText3(readErr)}`, { cause: readErr });
      }
    };
    next("\u4E0B\u8F7D\u98CE\u683C\u6D77\u62A5");
    await stage("\u4E0B\u8F7D\u98CE\u683C\u6D77\u62A5", "/styles/*/poster.jpg");
    for (let i = 0; i < entries.length; i += demoBatch) {
      const end = Math.min(i + demoBatch, entries.length);
      const label = `\u4E0B\u8F7D demo \u6E90\u7801\uFF08\u7B2C ${i / demoBatch + 1}/${batches} \u6279\uFF09`;
      next(label);
      await stage(label, ...entries.slice(i, end).map((style3) => "/styles/" + style3.slug + "/demo/"));
    }
    next("\u4E0B\u8F7D core/assets \u6A21\u578B\u4E0E\u8D34\u56FE");
    await stage("\u4E0B\u8F7D core/assets", "/core/assets/");
    patterns = [...fullSparse];
    await stage("\u6574\u7406\u98CE\u683C\u5E93");
    next("\u5B89\u88C5 three.js \u4F9D\u8D56\uFF08npm ci\uFF09");
    await setupNode(lib, { env: opts.env, output: opts.output }, signal);
    import_node_fs8.default.writeFileSync(import_node_path9.default.join(lib.dir, ".git", completeMarker), lib.commit + "\n", { mode: 420 });
    return lib;
  } finally {
    unlock();
  }
}
var nodeMarker = ".am-ok";
async function setupNode(lib, opts, signal) {
  let want;
  try {
    want = filesDigest(import_node_path9.default.join(lib.dir, "package.json"), import_node_path9.default.join(lib.dir, "package-lock.json"));
  } catch (err) {
    throw new Error(`\u8BFB\u53D6\u98CE\u683C\u5E93\u7684 package.json\uFF1A${errorText3(err)}`, { cause: err });
  }
  const marker = import_node_path9.default.join(lib.dir, "node_modules", nodeMarker);
  let got = "";
  try {
    got = import_node_fs8.default.readFileSync(marker, "utf8");
  } catch {
  }
  if (got.trim() === want) return;
  let npm;
  try {
    npm = lookPath("npm", opts.env.PATH ?? "");
  } catch (err) {
    throw new Error(`\u627E\u4E0D\u5230 npm\uFF08\u9700\u8981 Node 20+\uFF09\uFF0C\u65E0\u6CD5\u5B89\u88C5\u98CE\u683C\u5E93\u7684 three.js\uFF1A${errorText3(err)}`, { cause: err });
  }
  const output2 = opts.output ?? { write: () => true };
  output2.write("\u5B89\u88C5\u98CE\u683C\u5E93\u7684 Node \u4F9D\u8D56\uFF08npm ci\uFF09\u2026\n");
  try {
    await runCommand2(npm, ["ci", "--no-audit", "--no-fund", "--loglevel=error", "--ignore-scripts"], {
      cwd: lib.dir,
      env: opts.env,
      stdout: output2,
      stderr: output2,
      signal
    });
  } catch (err) {
    throw new Error(`npm ci \u5931\u8D25\uFF1A${errorText3(err)}`, { cause: err });
  }
  import_node_fs8.default.mkdirSync(import_node_path9.default.dirname(marker), { recursive: true });
  import_node_fs8.default.writeFileSync(marker, want + "\n", { mode: 420 });
}
function filesDigest(...files2) {
  const hash = import_node_crypto4.default.createHash("sha256");
  for (const file of files2) hash.update(import_node_fs8.default.readFileSync(file));
  return hash.digest("hex").slice(0, 16);
}

// ../engine/src/filmstyle/lemo/fill.ts
var import_node_fs10 = __toESM(require("node:fs"), 1);
var import_node_path11 = __toESM(require("node:path"), 1);

// ../engine/src/filmstyle/lemo/attribution.md.tmpl
var attribution_md_default = "# \u6765\u6E90\n\n- \u98CE\u683C\uFF1A{{.Style.CN}} \xB7 {{.Style.EN}}\uFF08`{{.Style.Slug}}`\uFF09\n- \u98CE\u683C\u5E93\uFF1Alemo-opuscar\uFF0C\u4F5C\u8005 LemoLab\uFF0C{{.Repo}}\n- commit\uFF1A`{{.Commit}}`\n- \u5B89\u88C5\u65B9\u5F0F\uFF1A`am film-style use {{.Style.Slug}}`\uFF0C\u4ECE\u56FA\u5B9A commit \u62F7\u8D1D\uFF0C\u4E0D\u8DDF\u968F\u4E0A\u6E38 main\n\n## \u4FDD\u7559\u4E86\u4EC0\u4E48\n\n- `styles/{{.Style.Slug}}/` \u4E0B\u7684 `STYLE.md`\u3001`style.json`\u3001`DEMO.md`\u3001`poster.jpg` \u4E0E `demo/` \u6E90\u7801\uFF0C\u539F\u6837\u62F7\u8D1D\n- \u98CE\u683C\u5E93\u7684 `core/lib.js`\u3001`core/three/`\u3001`core/post/`\u3001`core/fonts/`\uFF0C\u539F\u6837\u62F7\u8D1D\n{{- if .Style.ThreeJS}}\n- \u98CE\u683C\u5E93 `node_modules/three/` \u7684 `build/` \u4E0E `examples/jsm/`\uFF08three.js\uFF0CMIT\uFF09\n{{- end}}\n\n## \u4E22\u4E86\u4EC0\u4E48\n\n- `demo/stills/`\u3001`demo/out/` \u7B49\u5BA1\u7247\u622A\u56FE\u4E0E\u6E32\u67D3\u4EA7\u7269\uFF0C\u4EE5\u53CA\u97F3\u9891\u6587\u4EF6\n- \u98CE\u683C\u5E93\u7684\u5BFC\u6F14\u6D41\u7A0B\uFF08`AGENTS.md`\u3001`DIRECTOR.md`\uFF09\uFF1A\u6545\u4E8B\u3001\u5206\u955C\u3001\u914D\u97F3\u7531 am \u7684\u5236\u4F5C\u6D41\u7A0B\u8D1F\u8D23\n- \u98CE\u683C\u5E93\u7684\u6E32\u67D3\u4E0E\u5408\u6210\u5DE5\u5177\uFF08`core/render/`\uFF09\uFF1A\u6E32\u67D3\u8D70 HyperFrames\n\n## \u6539\u4E86\u54EA\u51E0\u5904\n\n- `SKILL.md` \u4E0E\u672C\u6587\u4EF6\u7531 am \u751F\u6210\uFF0C\u8BF4\u660E\u8FD9\u5957\u98CE\u683C\u5728 HyperFrames \u955C\u5934\u91CC\u600E\u4E48\u7528\n\n## \u8BB8\u53EF\n\n- \u4EE3\u7801\u4E0E\u6587\u6863\uFF1AMIT\uFF08\u89C1 `LICENSE`\uFF09\n- demo \u7247\u53CA\u5176\u753B\u9762\uFF1ACC BY 4.0\uFF0C\u590D\u7528\u65F6\u7F72\u540D LemoLab \u5E76\u94FE\u63A5\u4E0A\u6E38\u4ED3\u5E93\uFF0C\u8BF4\u660E\u6539\u52A8\n- demo \u91CC\u7684\u7B2C\u4E09\u65B9\u7D20\u6750\uFF1A\u5404\u81EA\u7684\u8BB8\u53EF\uFF0C\u89C1 `demo/CREDITS`\n- \u7528\u8FD9\u5957\u98CE\u683C\u505A\u51FA\u7684\u7247\u5B50\u5F52\u5236\u4F5C\u8005\u6240\u6709\uFF0C\u4E0D\u9700\u8981\u7F72\u540D\n";

// ../engine/src/filmstyle/lemo/skill.md.tmpl
var skill_md_default = '---\nname: am-film-style\ndescription: \u672C\u7247\u7684\u6574\u7247\u98CE\u683C\u300C{{.Style.CN}} {{.Style.EN}}\u300D\uFF0C\u6765\u81EA lemo-opuscar \u98CE\u683C\u5E93\uFF08{{.Short}}\uFF09\u3002\u6BCF\u4E2A\u955C\u5934\u90FD\u5FC5\u987B\u9075\u5B88 STYLE.md \u7684\u4E0D\u53D8\u91CF\uFF1Bdemo \u53EA\u7528\u6765\u5B66\u6280\u6CD5\u3002\n---\n\n# \u6574\u7247\u98CE\u683C\uFF1A{{.Style.CN}} \xB7 {{.Style.EN}}\n\n\u672C\u7247\u7684\u6BCF\u4E2A\u955C\u5934\u90FD\u753B\u6210\u8FD9\u4E00\u79CD\u98CE\u683C\u3002\u5B83\u6765\u81EA lemo-opuscar \u98CE\u683C\u5E93\uFF08`{{.Style.Slug}}`\uFF0Ccommit `{{.Short}}`\uFF09\uFF0C\u7531 `am film-style use` \u88C5\u8FDB\u9879\u76EE\uFF0C\u4E0D\u8981\u624B\u6539\u672C\u76EE\u5F55\u3002\n\n| \u6587\u4EF6 | \u7528\u9014 |\n|---|---|\n| `STYLE.md` | \u98CE\u683C\u7684\u4E0D\u53D8\u91CF\uFF1A\u957F\u4EC0\u4E48\u6837\u3001\u914D\u8272\u903B\u8F91\u3001\u5B57\u4F53\u3001\u52A8\u6548\u8D28\u611F\u3001\u955C\u5934\u8BED\u6CD5\u3001\u6807\u5FD7\u624B\u6CD5\u3001\u7981\u5FCC\u3001\u5F15\u64CE\u7528\u6CD5\u3002**\u5168\u90E8\u9075\u5B88** |\n| `DEMO.md`\u3001`demo/` | \u4E0A\u6E38 demo \u7247\u7684\u8BF4\u660E\u4E0E\u6E90\u7801\u3002\u53EA\u7528\u6765\u5B66\u6280\u6CD5\uFF08\u5F15\u64CE\u3001\u7B14\u5237\u3001rig\u3001shader\u3001\u540E\u671F\uFF09 |\n| `core/` | \u98CE\u683C\u5E93\u7684\u5171\u7528\u5DE5\u5177\uFF1A`lib.js`\uFF08\u79CD\u5B50\u968F\u673A\u3001\u566A\u58F0\u3001\u7F13\u52A8\u3001\u63D2\u503C\uFF09{{if .Style.ThreeJS}}\u3001`three/post.js`\uFF08three.js \u540E\u671F\uFF09{{end}}\u3001`post/`\u3001`fonts/` |\n{{- if .Style.ThreeJS}}\n| `node_modules/three/` | demo \u7528\u5230\u7684 three.js\uFF08\u968F\u98CE\u683C\u5E93\u9501\u5B9A\u7684\u7248\u672C\uFF09 |\n{{- end}}\n| `ATTRIBUTION.md`\u3001`LICENSE` | \u6765\u6E90\u4E0E\u8BB8\u53EF |\n\n## \u7ED9\u5236\u4F5C\u7684\u8BF4\u660E\uFF08\u5B9A\u65B9\u6848\u3001\u5907\u7D20\u6750\u65F6\u8BFB\uFF09\n\n- \u5148\u5199 `treatment.md`\uFF0C\u518D\u770B `DEMO.md` \u4E0E `demo/`\uFF1Ademo \u53EA\u7528\u6765\u5B66\u6280\u6CD5\uFF08\u5F15\u64CE\u3001\u7B14\u89E6\u3001rig\u3001shader\uFF09\uFF0C\u4E0D\u501F\u5B83\u7684\u6545\u4E8B\u3001\u7ED3\u6784\u3001\u955C\u5934\u3001\u9053\u5177\u548C\u65F6\u95F4\u7EBF\u3002\u4EE5\u771F\u5B9E\u7D20\u6750\u4E3A\u672C\u7684\u98CE\u683C\uFF08\u526A\u8F91\u4E0E\u7EAA\u5B9E\u3001\u5B9E\u8BC1\u5F71\u50CF\uFF09\u4F8B\u5916\uFF1A\u5148\u6309 STYLE.md \u6536\u96C6\u5E76\u767B\u8BB0\u7D20\u6750\uFF0C\u518D\u5199 treatment\u3002\n- STYLE.md \u70B9\u540D\u7684\u5B57\u4F53\u4E0D\u968F\u98CE\u683C\u5E93\u4E0B\u53D1\uFF0C\u6309\u5236\u4F5C\u63D0\u793A\u8BCD\u300C\u6574\u7247\u98CE\u683C\u300D\u4E00\u8282\u7684\u529E\u6CD5\u4ECE Google Fonts \u53D6\u3002`core/fonts/` \u91CC\u7684\u4E2D\u6587\u5C55\u793A\u5B57\u4F53\u53EA\u6709\u7EA6 200 \u4E2A\u5B57\uFF0C\u4E0D\u80FD\u7528\u4E8E\u4E2D\u6587\u6B63\u6587\u3002\n- STYLE.md \u7684 Sound palette \u53EA\u4F5C\u4E3A\u9009\u66F2\u65B9\u5411\u7684\u53C2\u8003\uFF1B\u98CE\u683C\u5E93\u81EA\u5E26\u7684\u914D\u4E50\u5DE5\u5177\u6CA1\u6709\u63A5\u5165\u3002\n\n## \u89C4\u5219\uFF08\u6E32\u67D3\u955C\u5934\u65F6\uFF09\n\n1. **\u5148\u8BFB `STYLE.md` \u5168\u6587\u518D\u52A8\u624B\u3002** \u5B83\u89C4\u5B9A\u7684\u5916\u89C2\u3001\u6750\u8D28\u3001\u914D\u8272\u903B\u8F91\u3001\u5B57\u4F53\u3001\u52A8\u6548\u8D28\u611F\u3001\u955C\u5934\u8BED\u6CD5\u3001\u6807\u5FD7\u624B\u6CD5\u4E0E\u7981\u5FCC\u5168\u90E8\u9075\u5B88\u3002\u672C\u955C\u5934\u63D0\u793A\u8BCD\u91CC\u7684\u300C\u5168\u7247\u914D\u8272\u300D\u82E5\u4E0E STYLE.md \u7684\u914D\u8272\u903B\u8F91\u51B2\u7A81\uFF0C\u4EE5\u5168\u7247\u914D\u8272\u4E3A\u51C6\u2014\u2014\u5B83\u662F\u5728 STYLE.md \u7684\u914D\u8272\u903B\u8F91\u91CC\u4E3A\u672C\u7247\u9009\u5B9A\u7684\u3002\n2. **\u5185\u5BB9\u6765\u81EA\u672C\u955C\u5934\uFF0C\u4E0D\u6765\u81EA demo\u3002** \u753B\u4EC0\u4E48\u3001\u8BB2\u4EC0\u4E48\u3001\u51FA\u73B0\u54EA\u4E9B\u7269\u4EF6\uFF0C\u53EA\u53D6\u672C\u955C\u5934\u7684 prompt.md\u3001\u5B57\u5E55\u4E0E\u7D20\u6750\u3002\u4E0D\u7167\u642C demo \u7684\u6545\u4E8B\u3001\u955C\u5934\u3001\u9053\u5177\u3001\u6587\u6848\u3001\u65F6\u95F4\u7EBF\u548C\u89D2\u8272\uFF0C\u4E0D\u628A\u9898\u6750\u5F80 demo \u4E0A\u9760\u3002\n3. **demo \u662F\u6280\u6CD5\u5E93\u3002** \u9700\u8981\u5B83\u7684\u5F15\u64CE\u65F6\uFF0C\u8BFB `STYLE.md` \u7684 Engine \u4E00\u8282\u4E0E `DEMO.md`\uFF0C\u518D\u628A\u7528\u5230\u7684\u6E90\u7801\u6587\u4EF6\u62F7\u8FDB\u672C\u955C\u5934\u76EE\u5F55\u3001\u5728\u62F7\u8D1D\u4E0A\u4FEE\u6539\u3002\u4E0D\u5F97\u5728\u5408\u6210\u91CC\u5F15\u7528\u672C\u76EE\u5F55\uFF08\u955C\u5934\u76EE\u5F55\u4E4B\u5916\u7684\u8DEF\u5F84\u6E32\u67D3\u65F6\u4F1A\u9759\u9ED8 404\uFF09\u3002\n4. **\u53EA\u62F7\u4F60\u7528\u5230\u7684\u6587\u4EF6\uFF0C\u4FDD\u6301\u539F\u8DEF\u5F84\u3002** demo \u7528 `/core/lib.js`\u3001`/core/three/post.js` \u8FD9\u7C7B\u4EE5 `/` \u5F00\u5934\u7684\u8DEF\u5F84\u5F15\u7528\u5171\u7528\u5DE5\u5177\uFF1BHyperFrames \u4EE5\u955C\u5934\u76EE\u5F55\u4E3A\u6839\u63D0\u4F9B\u6587\u4EF6\uFF0C\u6240\u4EE5\u7528\u5230\u54EA\u4E2A\u5C31\u628A\u5B83\u62F7\u6210\u955C\u5934\u76EE\u5F55\u91CC\u7684\u540C\u4E00\u8DEF\u5F84\uFF08`core/lib.js`\uFF09\uFF0C\u8DEF\u5F84\u4E0D\u7528\u6539\u3002\u4E0D\u8981\u6574\u76EE\u5F55\u62F7\u8D1D\u3002\u4E0D\u8981\u6539\u672C\u76EE\u5F55\u91CC\u7684\u6587\u4EF6\uFF08\u5B83\u4EEC\u4E0E\u5176\u4ED6\u9879\u76EE\u5171\u7528\u540C\u4E00\u4EFD\uFF09\uFF0C\u6539\u52A8\u53EA\u6539\u955C\u5934\u76EE\u5F55\u91CC\u7684\u526F\u672C\u3002{{if .Style.ThreeJS}}three.js \u540C\u7406\uFF1A`node_modules/three/` \u91CC\u53EA\u6709 demo \u7528\u5230\u7684\u6A21\u5757\uFF0C\u4F60\u7684\u4EE3\u7801 import \u4E86\u54EA\u4E9B\uFF0C\u5C31\u628A\u5B83\u4EEC\uFF08`build/three.module.js` \u52A0\u4E0A\u7528\u5230\u7684 `examples/jsm/\u2026`\uFF0C\u8FDE\u540C\u5B83\u4EEC\u76F8\u5BF9\u5F15\u7528\u7684\u6587\u4EF6\uFF09\u62F7\u8FDB\u955C\u5934\u76EE\u5F55\u7684 `node_modules/three/` \u540C\u4E00\u8DEF\u5F84\uFF0Cimportmap \u4E0D\u7528\u6539\u3002demo \u5F15\u7528\u7684 `.hdr` \u73AF\u5883\u8D34\u56FE\u4E0D\u968F\u98CE\u683C\u5E93\u4E0B\u53D1\uFF0C\u7528 three \u7684 `RoomEnvironment` \u4EE3\u66FF\u3002{{end}}\n5. **\u9875\u9762\u5951\u7EA6\u6362\u6210 HyperFrames \u7684\u3002** demo \u9875\u9762\u5BFC\u51FA `window.render(t)`\uFF0C\u6309\u79D2\u9010\u5E27\u7ED8\u5236\u3001\u53EF\u5355\u72EC\u6E32\u67D3\u4EFB\u610F\u4E00\u5E27\u3002\u5728 HyperFrames \u91CC\u6539\u7531 `hf-seek` \u4E8B\u4EF6\u9A71\u52A8\uFF1A\u5728\u76D1\u542C\u5668\u91CC\u8C03\u7528\u540C\u4E00\u4E2A `render(e.detail.time)`\uFF0C\u6839\u5143\u7D20\u5199 `data-duration`\uFF0C\u52A0\u8F7D\u5B8C\u5148\u753B\u4E00\u6B21\u7B2C 0 \u5E27\uFF1B\u5F15\u64CE\u521D\u59CB\u5316\uFF08\u89E3\u7801\u56FE\u7247\u3001\u7F16\u8BD1 shader\u3001\u751F\u6210\u7B14\u89E6\uFF09\u8FD9\u7C7B\u5F02\u6B65\u51C6\u5907\u767B\u8BB0\u6210 `window.__hf.buildReady["<key>"]` promise\u3002\u5199\u6CD5\u4EE5 hyperframes \u6280\u80FD `references/runtimes.md` \u7684\u300CThe seek protocol\u300D\u4E3A\u51C6\u3002\u4E0D\u8981 `window.READY`\uFF0C\u4E0D\u8981 `requestAnimationFrame`\uFF0C\u4E0D\u8BFB\u771F\u5B9E\u65F6\u949F\uFF1B\u968F\u673A\u6570\u4E00\u5F8B\u7528 `core/lib.js` \u7684 `mulberry` / `hash` \u52A0\u56FA\u5B9A\u79CD\u5B50\uFF0C\u4EFB\u4F55\u4E00\u5E27\u90FD\u4E0D\u80FD\u4F9D\u8D56\u4E0A\u4E00\u5E27\u7559\u4E0B\u7684\u72B6\u6001\u3002\n6. **\u753B\u5E45\u3001\u5E27\u7387\u4E0E\u65F6\u957F\u4EE5\u672C\u955C\u5934\u63D0\u793A\u8BCD\u4E3A\u51C6\u3002** demo \u9ED8\u8BA4 1920\xD71080\u300124fps\u3002\u4ECE `innerWidth` \xD7 `innerHeight` \u6392\u7248\uFF0C\u4E0D\u5199\u6B7B 1920\xD71080\uFF1B\u7AD6\u5C4F\u8981\u6309\u7AD6\u5C4F\u91CD\u65B0\u6784\u56FE\uFF0C\u4E0D\u662F\u628A\u6A2A\u5C4F\u753B\u9762\u7F29\u5C0F\u6216\u88C1\u4E00\u5757\u3002STYLE.md \u8981\u6C42\u300C\u4E00\u62CD\u4E24\u5E27\u300D\u4E4B\u7C7B\u7684\u6B65\u8FDB\u65F6\uFF0C\u53EA\u6B65\u8FDB\u753B\u9762\u91CC\u7684\u7269\u4EF6\uFF0C\u955C\u5934\u4E0E\u5149\u7167\u4FDD\u6301\u9010\u5E27\u5E73\u6ED1\u3002\n7. **\u5B57\u4F53\u3002** STYLE.md \u70B9\u540D\u7684\u5B57\u4F53\u7531\u4E0A\u5C42\u653E\u8FDB\u955C\u5934\u76EE\u5F55\uFF1B\u955C\u5934\u76EE\u5F55\u91CC\u6CA1\u6709\u65F6\uFF0C\u7528\u955C\u5934\u76EE\u5F55\u91CC\u5DF2\u6709\u7684\u5B57\u4F53\u5E76\u5728\u6C47\u62A5\u91CC\u8BF4\u660E\uFF0C\u4E0D\u5F97\u6539\u7528\u672C\u673A\u7CFB\u7EDF\u5B57\u4F53\u6216 `local()`\u3002\u4E2D\u6587\u8981\u6709\u4E2D\u6587\u5B57\u4F53\u8986\u76D6\uFF1A`core/fonts/` \u91CC\u7684\u4E2D\u6587\u5C55\u793A\u5B57\u4F53\u53EA\u6709\u7EA6 200 \u4E2A\u5B57\uFF0C\u4E0D\u80FD\u7528\u4E8E\u6B63\u6587\u3002\u5B57\u5E55\u7684\u5B57\u4F53\u4E0E\u6837\u5F0F\u6309 STYLE.md \u7684 Type & subtitles\uFF0C\u70E7\u5F55\u4ECD\u7528\u955C\u5934\u5DE5\u5177\u5E93\u7684 `SceneKit.captions`\u3002\n8. **\u58F0\u97F3\u4E00\u8282\u5BF9\u955C\u5934\u65E0\u6548\u3002** \u955C\u5934\u4EA7\u7269\u5FC5\u987B\u9759\u97F3\u3001\u65E0\u97F3\u8F68\uFF1BSTYLE.md \u7684 Sound palette \u7531\u4E0A\u5C42\u914D\u4E50\u65F6\u4F7F\u7528\u3002\n9. **\u80F6\u7247\u9897\u7C92\u4E0D\u753B\u8FDB\u9875\u9762\u3002** lemo \u5728\u5408\u6210\u6210\u7247\u65F6\u7528 ffmpeg \u52A0\u9897\u7C92\uFF1B\u9897\u7C92\u753B\u8FDB\u9875\u9762\u4F1A\u8BA9\u6BCF\u4E00\u5E27\u90FD\u65E0\u6CD5\u538B\u7F29\u3001\u6E32\u67D3\u53D8\u6162\u3002STYLE.md \u5199\u4E86\u9897\u7C92\u65F6\uFF0C\u672C\u955C\u5934\u7701\u7565\u5B83\u3002\n10. **\u771F\u5B9E\u7D20\u6750\u53EA\u7528\u7ED9\u5230\u7684\u3002** \u526A\u8F91\u4E0E\u7EAA\u5B9E\u3001\u5B9E\u8BC1\u5F71\u50CF\u8FD9\u7C7B\u4EE5\u771F\u5B9E\u7D20\u6750\u4E3A\u672C\u7684\u98CE\u683C\uFF0C\u53EA\u7528\u955C\u5934\u76EE\u5F55\u91CC\u5DF2\u6709\u7684\u7D20\u6750\u4E0E\u6570\u636E\uFF0C\u4E0D\u81EA\u884C\u4E0B\u8F7D\uFF0C\u4E0D\u7F16\u9020\u6570\u5B57\u4E0E\u51FA\u5904\u3002\n';

// ../engine/src/filmstyle/lemo/select.ts
var import_node_fs9 = __toESM(require("node:fs"), 1);
var import_node_path10 = __toESM(require("node:path"), 1);
function sourceTexts(skillDir2) {
  const out = /* @__PURE__ */ new Map();
  const walk = (dir, rel) => {
    for (const entry of sortedEntries2(dir)) {
      const file = import_node_path10.default.join(dir, entry.name);
      const childRel = rel + "/" + entry.name;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "assets" && rel === "core") continue;
        walk(file, childRel);
        continue;
      }
      switch (goExt(entry.name).toLowerCase()) {
        case ".js":
        case ".mjs":
        case ".html":
        case ".json":
          break;
        default:
          continue;
      }
      out.set(childRel, import_node_fs9.default.readFileSync(file, "utf8"));
    }
  };
  for (const sub of ["demo", "core"]) {
    const root = import_node_path10.default.join(skillDir2, sub);
    let stat;
    try {
      stat = import_node_fs9.default.statSync(root);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    walk(root, sub);
  }
  return out;
}
var specifierPattern = /(?:\bfrom[\t\n\f\r ]*|\bimport[\t\n\f\r ]*\([\t\n\f\r ]*|\bimport[\t\n\f\r ]+)['"]([^'"]+)['"]/g;
function specifiers(text) {
  return [...text.matchAll(specifierPattern)].map((match) => match[1]);
}
function isRegularFile(file) {
  try {
    return import_node_fs9.default.statSync(file).isFile();
  } catch {
    return false;
  }
}
function threeClosure(threeRoot, sources2) {
  const picked = /* @__PURE__ */ new Set();
  const queue = [];
  const add = (rel) => {
    rel = goClean(rel);
    if (rel === "." || rel.startsWith("../") || picked.has(rel)) return;
    if (!isRegularFile(import_node_path10.default.join(threeRoot, rel))) return;
    picked.add(rel);
    queue.push(rel);
  };
  const resolve3 = (spec, from) => {
    if (spec === "three") add("build/three.module.js");
    else if (spec === "three/webgpu") add("build/three.webgpu.js");
    else if (spec.startsWith("three/addons/")) add("examples/jsm/" + spec.slice("three/addons/".length));
    else if (spec.startsWith("three/examples/jsm/")) add(spec.slice("three/".length));
    else if (spec.startsWith("/node_modules/three/")) add(spec.slice("/node_modules/three/".length));
    else if (from !== "" && (spec.startsWith("./") || spec.startsWith("../"))) add(goJoin(goDir(from), spec));
  };
  add("build/three.module.js");
  for (const text of sources2.values()) {
    for (const spec of specifiers(text)) resolve3(spec, "");
  }
  while (queue.length > 0) {
    const rel = queue.shift();
    const body = import_node_fs9.default.readFileSync(import_node_path10.default.join(threeRoot, rel), "utf8");
    for (const spec of specifiers(body)) resolve3(spec, rel);
  }
  return [...picked].sort(compareBytes);
}
function referencedAssets(assetsRoot, sources2) {
  let text = "";
  for (const body of sources2.values()) text += body + "\n";
  const out = [];
  const walk = (dir, rel) => {
    for (const entry of sortedEntries2(dir)) {
      const file = import_node_path10.default.join(dir, entry.name);
      const childRel = rel === "" ? entry.name : rel + "/" + entry.name;
      if (entry.isDirectory()) {
        if (childRel.split("/").length - 1 === 1 && text.includes(entry.name)) addTree(file, childRel, out);
        else walk(file, childRel);
        continue;
      }
      const name = entry.name;
      const stem = name.slice(0, name.length - goExt(name).length);
      if (name === "SOURCES.md" || text.includes(name) || Buffer.byteLength(stem) >= 4 && text.includes(stem)) {
        if (entry.isFile()) out.push(childRel);
      }
    }
  };
  walk(assetsRoot, "");
  return out.sort(compareBytes);
}
function addTree(dir, rel, out) {
  for (const entry of sortedEntries2(dir)) {
    if (entry.isDirectory()) addTree(import_node_path10.default.join(dir, entry.name), rel + "/" + entry.name, out);
    else if (entry.isFile() && entry.name !== ".DS_Store") out.push(rel + "/" + entry.name);
  }
}

// ../engine/src/filmstyle/lemo/template.ts
var trimSet = " 	\r\n";
function trimLeft(s) {
  let i = 0;
  while (i < s.length && trimSet.includes(s[i])) i++;
  return s.slice(i);
}
function trimRight(s) {
  let i = s.length;
  while (i > 0 && trimSet.includes(s[i - 1])) i--;
  return s.slice(0, i);
}
function tokenize(name, source) {
  const tokens = [];
  let rest = source;
  let trimNext = false;
  for (; ; ) {
    const open = rest.indexOf("{{");
    let text = open < 0 ? rest : rest.slice(0, open);
    if (trimNext) text = trimLeft(text);
    if (open < 0) {
      tokens.push({ text });
      return tokens;
    }
    const close = rest.indexOf("}}", open + 2);
    if (close < 0) throw new Error(`template: ${name}: unclosed action`);
    let inner = rest.slice(open + 2, close);
    if (/^-[ \t\r\n]/.test(inner)) {
      text = trimRight(text);
      inner = inner.slice(1);
    }
    trimNext = false;
    if (/[ \t\r\n]-$/.test(inner)) {
      trimNext = true;
      inner = inner.slice(0, -1);
    }
    tokens.push({ text, action: inner.trim() });
    rest = rest.slice(close + 2);
  }
}
function parseField(name, expr) {
  if (!/^(\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(expr)) throw new Error(`template: ${name}: unsupported action ${JSON.stringify(expr)}`);
  return expr.slice(1).split(".");
}
function parse(name, source) {
  const root = [];
  const stack = [root];
  for (const token of tokenize(name, source)) {
    const current = stack[stack.length - 1];
    if (token.text !== "") current.push({ kind: "text", text: token.text });
    if (token.action === void 0) continue;
    const action = token.action;
    if (action === "end") {
      if (stack.length === 1) throw new Error(`template: ${name}: unexpected {{end}}`);
      stack.pop();
    } else if (action.startsWith("if ")) {
      const node = { kind: "if", path: parseField(name, action.slice(3).trim()), body: [] };
      current.push(node);
      stack.push(node.body);
    } else {
      current.push({ kind: "field", path: parseField(name, action) });
    }
  }
  if (stack.length !== 1) throw new Error(`template: ${name}: unexpected EOF`);
  return root;
}
function resolve2(name, data, fieldPath) {
  let value = data;
  for (const field of fieldPath) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, field)) {
      throw new Error(`template: ${name}: executing "${name}": can't evaluate field ${field}`);
    }
    value = value[field];
  }
  return value;
}
function truthy(value) {
  if (value === null || value === void 0) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return Boolean(value);
}
function print(value) {
  if (value === null || value === void 0) return "<no value>";
  if (Array.isArray(value)) return "[" + value.map(print).join(" ") + "]";
  return String(value);
}
function execute(name, nodes, data) {
  let out = "";
  for (const node of nodes) {
    if (node.kind === "text") out += node.text;
    else if (node.kind === "field") out += print(resolve2(name, data, node.path));
    else if (truthy(resolve2(name, data, node.path))) out += execute(name, node.body, data);
  }
  return out;
}
function renderTemplate(name, source, data) {
  return execute(name, parse(name, source), data);
}

// ../engine/src/filmstyle/lemo/fill.ts
function fill(dir, entry, lib) {
  const source = import_node_path11.default.join(lib.dir, "styles", entry.slug);
  const place = (from, to) => copyPath(from, to, lib.managed);
  const copies = [
    { from: import_node_path11.default.join(source, "STYLE.md"), to: "STYLE.md" },
    { from: import_node_path11.default.join(source, "style.json"), to: "style.json" },
    { from: import_node_path11.default.join(source, "DEMO.md"), to: "DEMO.md" },
    { from: import_node_path11.default.join(source, "poster.jpg"), to: "poster.jpg" },
    { from: import_node_path11.default.join(lib.dir, "LICENSE"), to: "LICENSE" },
    { from: import_node_path11.default.join(source, "demo"), to: "demo" },
    { from: import_node_path11.default.join(lib.dir, "core", "lib.js"), to: "core/lib.js" },
    { from: import_node_path11.default.join(lib.dir, "core", "three"), to: "core/three" },
    { from: import_node_path11.default.join(lib.dir, "core", "post"), to: "core/post" },
    { from: import_node_path11.default.join(lib.dir, "core", "fonts"), to: "core/fonts" }
  ];
  for (const item of copies) {
    if (!pathExists(item.from)) {
      if (item.to === "STYLE.md" || item.to === "core/lib.js") throw new Error(`\u98CE\u683C\u5E93\u7F3A\u5C11 ${item.from}`);
      continue;
    }
    place(item.from, import_node_path11.default.join(dir, item.to));
  }
  const sources2 = sourceTexts(dir);
  if (demoUsesCoreAssets(import_node_path11.default.join(source, "demo"))) {
    const assets = import_node_path11.default.join(lib.dir, "core", "assets");
    if (!exists3(assets)) throw missing("\u98CE\u683C\u5E93\u7684 core/assets", entryLabel(entry) + " \u7684 demo \u8981\u7528");
    for (const rel of referencedAssets(assets, sources2)) {
      place(import_node_path11.default.join(assets, rel), import_node_path11.default.join(dir, "core", "assets", rel));
    }
  }
  if (entry.three_js) {
    const three = import_node_path11.default.join(lib.dir, "node_modules", "three");
    if (!exists3(import_node_path11.default.join(three, "build", "three.module.js"))) throw missing("\u98CE\u683C\u5E93\u7684 three.js \u4F9D\u8D56", entryLabel(entry) + " \u8981\u7528");
    const picked = threeClosure(three, sources2);
    for (const rel of ["LICENSE", "package.json", ...picked]) {
      const from = import_node_path11.default.join(three, rel);
      if (!exists3(from)) continue;
      place(from, import_node_path11.default.join(dir, "node_modules", "three", rel));
    }
  }
  renderSkill(dir, entry, lib.commit || "unknown");
}
function pathExists(file) {
  try {
    import_node_fs10.default.statSync(file);
    return true;
  } catch (err) {
    return err.code !== "ENOENT";
  }
}
var skipExtensions = /* @__PURE__ */ new Set([".mp4", ".wav", ".mp3", ".npy", ".log"]);
function copyPath(from, to, link) {
  const visit = (file, target, name, stat, isRoot) => {
    if (stat.isDirectory()) {
      if (!isRoot && (skipInDemo.has(name) || name.startsWith("out_") || name === "__pycache__")) return;
      import_node_fs10.default.mkdirSync(target, { recursive: true });
      for (const entry of sortedEntries2(file)) {
        const child = import_node_path11.default.join(file, entry.name);
        visit(child, import_node_path11.default.join(target, entry.name), entry.name, import_node_fs10.default.lstatSync(child), false);
      }
      return;
    }
    if (stat.isSymbolicLink()) throw new Error(`\u98CE\u683C\u5E93\u91CC\u6709\u7B26\u53F7\u94FE\u63A5\uFF0C\u65E0\u6CD5\u5B89\u5168\u642C\u8FDB\u9879\u76EE\uFF1A${file}`);
    if (!stat.isFile() || name === ".DS_Store" || skipExtensions.has(goExt(name).toLowerCase())) return;
    import_node_fs10.default.mkdirSync(import_node_path11.default.dirname(target), { recursive: true });
    if (link) {
      let linked = false;
      try {
        import_node_fs10.default.linkSync(file, target);
        linked = true;
      } catch {
      }
      if (linked) {
        import_node_fs10.default.chmodSync(target, 420);
        return;
      }
    }
    import_node_fs10.default.writeFileSync(target, import_node_fs10.default.readFileSync(file), { mode: 420 });
  };
  visit(from, to, import_node_path11.default.basename(from), import_node_fs10.default.lstatSync(from), true);
}
function loadTemplates() {
  return { skill: skill_md_default, attribution: attribution_md_default };
}
function renderSkill(dir, style3, commit) {
  const short = commit.length > 12 ? commit.slice(0, 12) : commit;
  const data = {
    Style: {
      Slug: style3.slug,
      Num: style3.num,
      EN: style3.en,
      CN: style3.cn,
      CategoryEN: style3.category_en,
      CategoryCN: style3.category_cn,
      Film: style3.film,
      Line: style3.line,
      LineCN: style3.line_cn,
      Uses: style3.uses,
      DemoSeconds: style3.demo_seconds,
      ThreeJS: style3.three_js
    },
    Commit: commit,
    Short: short,
    Repo: RepoURL.replace(/\.git$/, "")
  };
  const { skill, attribution } = loadTemplates();
  for (const [name, text] of [
    ["SKILL.md", skill],
    ["ATTRIBUTION.md", attribution]
  ]) {
    let out;
    try {
      out = renderTemplate(name, text, data);
    } catch (err) {
      throw new Error(`\u751F\u6210 ${name}\uFF1A${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    import_node_fs10.default.writeFileSync(import_node_path11.default.join(dir, name), out, { mode: 420 });
  }
}

// ../engine/src/filmstyle/lemo/source.ts
var import_node_fs11 = __toESM(require("node:fs"), 1);
var lemoSource = {
  id: () => SourceID,
  name: () => `lemo-opuscar \u98CE\u683C\u5E93\uFF08LemoLab\uFF0C${PinnedStyleCount} \u79CD\uFF09`,
  gallery: () => Gallery,
  envKeys: () => [LibraryEnv],
  catalog: () => catalog2().map(entryStyle),
  location: (env) => libraryDir({ env }),
  check: (env) => {
    requireLibrary({ env });
  },
  prepare: async (opts, signal) => {
    await prepareLibrary({ env: opts.env, output: opts.output, progress: opts.progress }, signal);
  },
  poster: (env, slug) => {
    const lib = openLibrary({ env });
    const file = posterPath(lib, slug);
    try {
      import_node_fs11.default.statSync(file);
    } catch {
      throw missing("\u98CE\u683C\u6D77\u62A5", file + " \u4E0D\u5B58\u5728");
    }
    return file;
  },
  fill: (dir, style3, env) => {
    const entry = find2(style3.slug);
    if (!entry) throw new Error(`lemo-opuscar \u98CE\u683C\u5E93\u91CC\u6CA1\u6709 ${goQuote(style3.slug)}`);
    const lib = requireLibrary({ env });
    requireStyle(lib, entry);
    fill(dir, entry, lib);
    return lib.commit || "unknown";
  }
};
register(lemoSource);

// src/canvas.ts
var import_node_fs12 = __toESM(require("node:fs"), 1);

// ../engine/src/preset/preset.ts
var AnchorTop = "top";
var AnchorBottom = "bottom";
var AnchorFill = "fill";

// ../engine/src/preset/table.ts
function baseSafeArea() {
  return [
    { name: "structural", leftPx: 40, rightPx: 40, anchor: AnchorFill, insetTopPx: 96, insetBottomPx: 60 },
    { name: "main_content", leftPx: 88, rightPx: 88, anchor: AnchorFill, insetTopPx: 120, insetBottomPx: 100 },
    { name: "critical_text", leftPx: 88, rightPx: 180, anchor: AnchorFill, insetTopPx: 120, insetBottomPx: 260 },
    { name: "cover_title", leftPx: 88, rightPx: 180, anchor: AnchorTop, insetTopPx: 260, heightPx: 720 },
    { name: "subtitles", leftPx: 88, rightPx: 180, anchor: AnchorBottom, insetBottomPx: 260, heightPx: 190 }
  ];
}
function verticalPlatform() {
  return {
    orientation: "\u7AD6\u5C4F",
    ui: "\u6296\u97F3\u53F3\u4FA7\u4E92\u52A8\u680F\u548C\u5E95\u90E8 UI",
    zone: "\u53F3\u4FA7\u4E92\u52A8\u680F\u548C\u5E95\u90E8 UI",
    avoidance: (critical) => `\u53F3\u4FA7 ${critical.rightPx}px \u548C\u5E95\u90E8 ${critical.bottomPx}px \u662F\u6296\u97F3\u4E92\u52A8\u680F\u4E0E\u5E95\u90E8 UI`
  };
}
function landscapeSafeArea() {
  return [
    { name: "structural", leftPx: 48, rightPx: 48, anchor: AnchorFill, insetTopPx: 40, insetBottomPx: 40 },
    { name: "main_content", leftPx: 120, rightPx: 120, anchor: AnchorFill, insetTopPx: 80, insetBottomPx: 96 },
    { name: "critical_text", leftPx: 160, rightPx: 160, anchor: AnchorFill, insetTopPx: 96, insetBottomPx: 200 },
    { name: "cover_title", leftPx: 160, rightPx: 160, anchor: AnchorTop, insetTopPx: 220, heightPx: 520 },
    { name: "subtitles", leftPx: 240, rightPx: 240, anchor: AnchorBottom, insetBottomPx: 90, heightPx: 150 }
  ];
}
function landscapePlatform() {
  return {
    orientation: "\u6A2A\u5C4F",
    ui: "\u64AD\u653E\u5668\u5E95\u90E8\u63A7\u5236\u680F\u4E0E\u8FDB\u5EA6\u6761",
    zone: "\u5E95\u90E8\u63A7\u5236\u680F\u4E0E\u8FDB\u5EA6\u6761",
    avoidance: (critical) => `\u5E95\u90E8 ${critical.bottomPx}px \u662F\u64AD\u653E\u5668\u63A7\u5236\u680F\u3001\u8FDB\u5EA6\u6761\u4E0E\u5F39\u5E55\u8F93\u5165\u533A`
  };
}
var landscapeLayoutNotes = `

## \u6A2A\u5C4F\u6784\u56FE\u8981\u70B9

\u672C\u9879\u76EE\u662F 16:9 \u6A2A\u5C4F\uFF081920\xD71080\uFF09\uFF0C\u753B\u9762\u7684\u4E3B\u65B9\u5411\u662F\u5DE6\u53F3\u800C\u4E0D\u662F\u4E0A\u4E0B\u3002\u98CE\u683C\u8BF4\u660E\u4E66\u91CC\u6309\u7AD6\u5C4F\u63CF\u8FF0\u7684\u7248\u5F0F\u9AA8\u67B6\uFF0C\u843D\u5230\u6A2A\u5C4F\u65F6\u6309\u4E0B\u9762\u7684\u539F\u5219\u6539\u6392\uFF1A

- \u5DE6\u53F3\u5206\u680F\u4F18\u5148\u4E8E\u4E0A\u4E0B\u5806\u53E0\uFF1A\u547D\u9898\u578B\u7528\u300C\u5DE6\u6587\u53F3\u56FE\u300D\u6216\u300C\u5DE6\u5927\u5B57\u3001\u53F3\u4E3B\u89C6\u89C9\u300D\uFF1B\u5BF9\u7167\u578B\u76F4\u63A5\u5DE6\u53F3\u5BF9\u5F00\uFF1B\u6D41\u7A0B\u578B\u6CBF\u6C34\u5E73\u65B9\u5411\u5C55\u5F00\uFF0C\u6700\u591A 5 \u6B65\uFF0C\u8D85\u8FC7\u5C31\u5206\u4E24\u884C\uFF1B\u7CFB\u7EDF\u603B\u89C8\u7528\u6A2A\u5411\u7F51\u683C\u3002
- \u4E0D\u8981\u628A\u7AD6\u5C4F\u7248\u5F0F\u539F\u6837\u5C45\u4E2D\uFF1A\u4E2D\u95F4\u4E00\u6761\u7A84\u680F\u3001\u4E24\u4FA7\u5927\u9762\u79EF\u7A7A\u767D\uFF0C\u662F\u6A2A\u5C4F\u6700\u5E38\u89C1\u7684\u300C\u6CA1\u6392\u5B8C\u300D\u3002
- \u4E00\u884C\u6587\u5B57\u4E0D\u8D85\u8FC7 22 \u4E2A\u6C49\u5B57\uFF1A\u6A2A\u5C4F\u5BBD\u5EA6\u5927\uFF0C\u5355\u884C\u8FC7\u957F\u4F1A\u8BA9\u89C6\u7EBF\u6765\u56DE\u626B\uFF0C\u5B81\u53EF\u65AD\u884C\u3002
- \u6807\u9898\u5B57\u53F7\u4EE5\u753B\u9762\u9AD8\u5EA6 1080px \u4E3A\u57FA\u51C6\uFF0C\u4E0E\u7AD6\u5C4F\u7684\u540C\u7EA7\u5B57\u53F7\u4FDD\u6301\u4E00\u81F4\uFF0C\u4E0D\u56E0\u4E3A\u753B\u9762\u53D8\u5BBD\u800C\u653E\u5927\u3002
- \u5E95\u90E8\u63A7\u5236\u680F\u4E0E\u8FDB\u5EA6\u6761\u662F\u5173\u952E\u907F\u8BA9\u533A\uFF1A\u6807\u9898\u3001\u6570\u5B57\u3001\u7ED3\u8BBA\u548C\u5B57\u5E55\u90FD\u4E0D\u5F97\u8FDB\u5165 critical_text \u4E0B\u6CBF\u4EE5\u4E0B\u7684\u533A\u57DF\uFF1B\u5B57\u5E55\u5E26\u8D34\u5728\u8FDB\u5EA6\u6761\u4E0A\u65B9\u3002
`;
var builtin = [
  {
    id: "vertical-3x4",
    label: "3:4  \u7AD6\u5C4F  1080\xD71440",
    canvas: { widthPx: 1080, heightPx: 1440, fps: 30, orientation: "vertical" },
    safeArea: baseSafeArea(),
    platform: verticalPlatform(),
    layoutNotes: ""
  },
  {
    id: "vertical-9x16",
    label: "9:16 \u7AD6\u5C4F  1080\xD71920",
    canvas: { widthPx: 1080, heightPx: 1920, fps: 30, orientation: "vertical" },
    safeArea: baseSafeArea(),
    platform: verticalPlatform(),
    layoutNotes: ""
  },
  {
    id: "landscape-16x9",
    label: "16:9 \u6A2A\u5C4F  1920\xD71080",
    canvas: { widthPx: 1920, heightPx: 1080, fps: 30, orientation: "landscape" },
    safeArea: landscapeSafeArea(),
    platform: landscapePlatform(),
    layoutNotes: landscapeLayoutNotes
  }
];
var clone = (p) => ({ ...p, canvas: { ...p.canvas }, safeArea: p.safeArea.map((b) => ({ ...b })) });
function all() {
  return builtin.map(clone);
}
function ids() {
  return builtin.map((p) => p.id);
}
function byID(id) {
  const p = builtin.find((item) => item.id === id);
  return p && clone(p);
}

// ../engine/src/preset/fonts.ts
var font = (file, family, weight, license) => ({ file, family, weight, license });
var FontNotoSerifSC400 = font("noto-serif-sc-400.woff2", "Noto Serif SC", 400, "LICENSE-noto-serif-sc.txt");
var FontNotoSerifSC700 = font("noto-serif-sc-700.woff2", "Noto Serif SC", 700, "LICENSE-noto-serif-sc.txt");
var FontLXGWWenKai400 = font("lxgw-wenkai-400.woff2", "LXGW WenKai", 400, "LICENSE-lxgw-wenkai.txt");
var FontXiaolai400 = font("xiaolai-400.woff2", "Xiaolai", 400, "LICENSE-xiaolai.txt");
var FontSmileySans400 = font("smiley-sans-oblique.woff2", "Smiley Sans", 400, "LICENSE-smiley-sans.txt");
var FontZCOOLKuaiLe400 = font("zcool-kuaile-400.woff2", "ZCOOL KuaiLe", 400, "LICENSE-zcool-kuaile.txt");
var FontZCOOLQingKe400 = font("zcool-qingke-huangyou-400.woff2", "ZCOOL QingKe HuangYou", 400, "LICENSE-zcool-qingke-huangyou.txt");
var FontFusionPixel400 = font("fusion-pixel-12px-zh_hans.woff2", "Fusion Pixel 12px Prop zh-Hans", 400, "LICENSE-fusion-pixel.txt");
var FontPressStart2P400 = font("press-start-2p-400.woff2", "Press Start 2P", 400, "LICENSE-press-start-2p.txt");
var FontSilkscreen400 = font("silkscreen-400.woff2", "Silkscreen", 400, "LICENSE-silkscreen.txt");
var FontOrbitron = font("orbitron-variable.woff2", "Orbitron", 700, "LICENSE-orbitron.txt");
var FontChakraPetch700 = font("chakra-petch-700.woff2", "Chakra Petch", 700, "LICENSE-chakra-petch.txt");
var FontFredoka600 = font("fredoka-600.woff2", "Fredoka", 600, "LICENSE-fredoka.txt");
var FontFredoka700 = font("fredoka-700.woff2", "Fredoka", 700, "LICENSE-fredoka.txt");
var FontBungee400 = font("bungee-400.woff2", "Bungee", 400, "LICENSE-bungee.txt");
var FontCinzel700 = font("cinzel-700.woff2", "Cinzel", 700, "LICENSE-cinzel.txt");
var FontBebasNeue400 = font("bebas-neue-400.woff2", "Bebas Neue", 400, "LICENSE-bebas-neue.txt");
var FontOxanium600 = font("oxanium-600.woff2", "Oxanium", 600, "LICENSE-oxanium.txt");
var FontSpaceGrotesk500 = font("space-grotesk-500.woff2", "Space Grotesk", 500, "LICENSE-space-grotesk.txt");
var FontSpaceGrotesk700 = font("space-grotesk-700.woff2", "Space Grotesk", 700, "LICENSE-space-grotesk.txt");
var FontCaveat600 = font("caveat-600.woff2", "Caveat", 600, "LICENSE-caveat.txt");
var allFonts = [
  FontNotoSerifSC400,
  FontNotoSerifSC700,
  FontLXGWWenKai400,
  FontXiaolai400,
  FontSmileySans400,
  FontZCOOLKuaiLe400,
  FontZCOOLQingKe400,
  FontFusionPixel400,
  FontPressStart2P400,
  FontSilkscreen400,
  FontOrbitron,
  FontChakraPetch700,
  FontFredoka600,
  FontFredoka700,
  FontBungee400,
  FontCinzel700,
  FontBebasNeue400,
  FontOxanium600,
  FontSpaceGrotesk500,
  FontSpaceGrotesk700,
  FontCaveat600
];
function allFontsCopy() {
  return allFonts.map((f) => ({ ...f }));
}
var SharedFonts = [
  font("noto-sans-sc-400.woff2", "Noto Sans SC", 400, "LICENSE-Noto-Sans-SC.txt"),
  font("noto-sans-sc-600.woff2", "Noto Sans SC", 600, "LICENSE-Noto-Sans-SC.txt"),
  font("noto-sans-sc-700.woff2", "Noto Sans SC", 700, "LICENSE-Noto-Sans-SC.txt"),
  font("noto-sans-sc-900.woff2", "Noto Sans SC", 900, "LICENSE-Noto-Sans-SC.txt")
];

// ../engine/src/preset/style.ts
var style = (id, name, label, sheetBackground, fonts = []) => ({ id, name, label, sheetBackground, fonts });
var builtinStyles = [
  style("clear-system-blueprint-v1", "\u6E05\u6670\u7CFB\u7EDF\u84DD\u56FE", "\u6E05\u6670\u7CFB\u7EDF\u84DD\u56FE\uFF1A\u77E5\u8BC6\u3001\u6280\u672F\u4E0E\u4EA7\u54C1\u673A\u5236\u8BB2\u89E3", "#D5DEEB"),
  style("pixel-arcade-v1", "\u50CF\u7D20\u8857\u673A", "\u50CF\u7D20\u8857\u673A\uFF1A8/16-bit \u590D\u53E4\u6E38\u620F\u3001\u6000\u65E7\u3001\u5165\u95E8\u79D1\u666E", "#1B1B2F", [FontFusionPixel400, FontPressStart2P400, FontSilkscreen400]),
  style("scifi-hud-v1", "\u79D1\u5E7BHUD", "\u79D1\u5E7B HUD\uFF1A\u822A\u5929\u3001\u786C\u4EF6\u3001\u7CFB\u7EDF\u67B6\u6784\u3001\u4EFB\u52A1\u5F0F\u8BB2\u89E3", "#0A1622", [FontOrbitron]),
  style("cyberpunk-glitch-v1", "\u8D5B\u535A\u6545\u969C", "\u8D5B\u535A\u6545\u969C\uFF1A\u5B89\u5168\u653B\u9632\u3001\u9ED1\u5BA2\u53D9\u4E8B\u3001\u53CD\u5DEE\u89C2\u70B9", "#120B1E", [FontSmileySans400, FontChakraPetch700]),
  style("candy-casual-v1", "\u7CD6\u679C\u4F11\u95F2", "\u7CD6\u679C\u4F11\u95F2\u624B\u6E38\uFF1A\u8F7B\u677E\u79D1\u666E\u3001\u751F\u6D3B\u6280\u5DE7\u3001\u6210\u957F\u6FC0\u52B1", "#FFE3EE", [FontZCOOLKuaiLe400, FontFredoka600, FontFredoka700]),
  style("rebel-graphic-v1", "\u4E8C\u6B21\u5143\u9510\u5229\u62FC\u8D34", "\u4E8C\u6B21\u5143\u9510\u5229\u62FC\u8D34\uFF1A\u5F3A\u89C2\u70B9\u3001\u6392\u884C\u3001\u89D2\u8272\u5316\u8868\u8FBE", "#111111", [FontZCOOLQingKe400, FontBungee400]),
  style("fantasy-quest-v1", "\u5947\u5E7B\u7F8A\u76AE\u5377", "\u5947\u5E7B\u7F8A\u76AE\u5377\uFF1A\u5386\u53F2\u3001\u6545\u4E8B\u3001\u5B66\u4E60\u8DEF\u7EBF\u3001\u4E16\u754C\u89C2", "#3B2A1A", [FontNotoSerifSC400, FontNotoSerifSC700, FontCinzel700]),
  style("esports-broadcast-v1", "\u7535\u7ADE\u8D5B\u4E8B\u8F6C\u64AD", "\u7535\u7ADE\u8D5B\u4E8B\u8F6C\u64AD\uFF1A\u5BF9\u6BD4\u8BC4\u6D4B\u3001\u6392\u884C\u699C\u3001\u6570\u636E\u6218\u62A5", "#0B0F1A", [FontBebasNeue400, FontOxanium600]),
  style("visual-novel-v1", "\u89C6\u89C9\u5C0F\u8BF4\u5BF9\u8BDD", "\u89C6\u89C9\u5C0F\u8BF4\u5BF9\u8BDD\uFF1A\u6545\u4E8B\u3001\u5BF9\u8BDD\u4F53\u3001\u60C5\u611F\u4E0E\u4EBA\u7269", "#2A2238", [FontLXGWWenKai400]),
  style("neon-data-dark-v1", "\u6697\u591C\u6570\u636E\u9713\u8679", "\u6697\u591C\u6570\u636E\u9713\u8679\uFF1AAI\u3001\u524D\u6CBF\u6280\u672F\u3001\u6570\u636E\u4E0E\u6307\u6807", "#070A12", [FontSpaceGrotesk500, FontSpaceGrotesk700]),
  style("editorial-magazine-v1", "\u6742\u5FD7\u7F16\u8F91\u6392\u7248", "\u6742\u5FD7\u7F16\u8F91\u6392\u7248\uFF1A\u89C2\u70B9\u3001\u4EBA\u6587\u3001\u5546\u4E1A\u8BC4\u8BBA", "#E8E2D6", [FontNotoSerifSC400, FontNotoSerifSC700]),
  style("whiteboard-doodle-v1", "\u767D\u677F\u624B\u7ED8", "\u767D\u677F\u624B\u7ED8\uFF1A\u6559\u7A0B\u3001\u6982\u5FF5\u62C6\u89E3\u3001\u8BFE\u5802\u8BB2\u89E3", "#E9ECEF", [FontXiaolai400, FontCaveat600]),
  style("anime-cel-v1", "\u65E5\u7CFB\u52A8\u6F2B", "\u65E5\u7CFB\u52A8\u6F2B\uFF1A\u756A\u5267\u611F\u79D1\u666E\u3001\u6210\u957F\u4E0E\u6311\u6218\u3001\u8F7B\u5FEB\u6545\u4E8B", "#8FD3FF", [FontSmileySans400, FontBebasNeue400])
];
var clone2 = (s) => ({ ...s, fonts: s.fonts.map((f) => ({ ...f })) });
function allStyles() {
  return builtinStyles.map(clone2);
}
function styleIDs() {
  return builtinStyles.map((s) => s.id);
}
function styleByID(id) {
  const s = builtinStyles.find((item) => item.id === id);
  return s && clone2(s);
}
var CustomStyleFlag = "custom";
var CustomStyleBriefPath = "docs/style-brief.md";
var AutomaticStyleBrief = "\u4E0D\u5957\u7528\u9884\u8BBE\u98CE\u683C\u3002\u8BF7\u6839\u636E\u672C\u7247\u4E3B\u9898\u3001\u53D7\u4F17\u548C\u7D20\u6750\u81EA\u4E3B\u8BBE\u8BA1\u4E00\u5957\u6E05\u6670\u3001\u7EDF\u4E00\u3001\u53EF\u6267\u884C\u7684\u89C6\u89C9\u98CE\u683C\uFF1B\u5148\u786E\u5B9A\u914D\u8272\u3001\u5B57\u4F53\u3001\u7248\u5F0F\u9AA8\u67B6\u3001\u52A8\u6548\u8BED\u6CD5\u4E0E\u7981\u7528\u9879\uFF0C\u518D\u6309\u9879\u76EE\u89C4\u8303\u5B8C\u6210\u98CE\u683C\u8BF4\u660E\u4E66\u548C\u793A\u4F8B\u56FE\u3002";
var DraftStyleID = "custom-draft";
var CustomStyle = Object.freeze({
  id: DraftStyleID,
  name: "\u81EA\u5B9A\u4E49",
  label: "\u81EA\u5B9A\u4E49\uFF1A\u65E7\u7248\u53C2\u6570\uFF08\u4E0D\u9650\u5236\u65B0\u955C\u5934\u89C6\u89C9\uFF09",
  sheetBackground: "#F5F7FB",
  fonts: []
});

// src/canvas.ts
function padRight(s, width) {
  const n = [...s].length;
  return n >= width ? s : s + " ".repeat(width - n);
}
function canvasOptions() {
  return all().map((p) => `  ${padRight(p.id, 16)}${p.label}`).join("\n");
}
function isTerminal(input) {
  return Boolean(input && input.isTTY);
}
async function resolveCanvas(flag, stdin, stdout) {
  if (flag !== "") {
    const p = byID(flag);
    if (!p) throw new Error(`\u672A\u77E5\u753B\u5E45 ${JSON.stringify(flag)}\uFF0C\u53EF\u9009\uFF1A
${canvasOptions()}`);
    return p;
  }
  if (!isTerminal(stdin)) throw new Error(`\u975E\u4EA4\u4E92\u73AF\u5883\u5FC5\u987B\u663E\u5F0F\u4F20\u5165 --canvas\uFF0C\u53EF\u9009\uFF1A
${canvasOptions()}`);
  return runPicker(canvasPicker(), "\u753B\u5E45", stdout);
}
function pickerView(picker, cursor) {
  let b = picker.title + "\n\n";
  picker.choices.forEach((choice, i) => {
    b += (i === cursor ? "\u276F " : "  ") + picker.label(choice) + "\n";
  });
  return b + "\n\u2191/\u2193 \u79FB\u52A8\u3000Enter \u786E\u8BA4\u3000Esc \u53D6\u6D88\n";
}
function pickerUpdate(state, count, key) {
  const up = () => ({ ...state, cursor: Math.max(0, state.cursor - 1) });
  const down = () => ({ ...state, cursor: Math.min(count - 1, state.cursor + 1) });
  if (key === "up") return up();
  if (key === "down") return down();
  if (key === "enter") return { ...state, confirmed: true };
  if (key === "ctrl-c" || key === "esc") return { ...state, aborted: true };
  if (key.rune === "k") return up();
  if (key.rune === "j") return down();
  if (key.rune === "q") return { ...state, aborted: true };
  return state;
}
function decodeKey(chunk) {
  if (chunk === "\x1B[A") return "up";
  if (chunk === "\x1B[B") return "down";
  if (chunk === "\r" || chunk === "\n") return "enter";
  if (chunk === "") return "ctrl-c";
  if (chunk === "\x1B") return "esc";
  return { rune: chunk };
}
function runPicker(picker, name, stdout) {
  const stdin = process.stdin;
  return new Promise((resolve3, reject) => {
    let state = { cursor: 0, confirmed: false, aborted: false };
    let lines = 0;
    const draw = () => {
      if (lines) stdout.write(`\x1B[${lines}F\x1B[J`);
      const view3 = pickerView(picker, state.cursor);
      stdout.write(view3);
      lines = view3.split("\n").length - 1;
    };
    const finish = () => {
      stdin.off("data", onData);
      try {
        stdin.setRawMode?.(false);
      } catch {
      }
      stdin.pause();
      if (state.aborted || !state.confirmed) reject(new Error("\u5DF2\u53D6\u6D88\u521D\u59CB\u5316"));
      else resolve3(picker.choices[state.cursor]);
    };
    const onData = (chunk) => {
      state = pickerUpdate(state, picker.choices.length, decodeKey(chunk.toString("utf8")));
      if (state.confirmed || state.aborted) finish();
      else draw();
    };
    try {
      stdin.setRawMode?.(true);
    } catch (err) {
      reject(new Error(`${name}\u9009\u62E9\u6846\u542F\u52A8\u5931\u8D25\uFF1A${err.message}`));
      return;
    }
    stdin.resume();
    stdin.on("data", onData);
    draw();
  });
}
function canvasPicker() {
  return { title: "\u9009\u62E9\u753B\u5E45", choices: all(), label: (p) => p.label };
}
var styleBriefPath = CustomStyleBriefPath;
var maxStyleBriefRunes = 4e3;
function styleOptions() {
  const lines = [`  ${padRight(CustomStyleFlag, 32)}${CustomStyle.label}`];
  for (const s of allStyles()) lines.push(`  ${padRight(s.id, 32)}${s.label}`);
  return lines.join("\n");
}
function resolveStyle(flag) {
  if (flag === "" || flag === CustomStyleFlag) return CustomStyle;
  const s = styleByID(flag);
  if (!s) throw new Error(`\u672A\u77E5\u98CE\u683C ${JSON.stringify(flag)}\uFF0C\u53EF\u9009\uFF1A
${styleOptions()}`);
  return s;
}
var defaultStyleBrief = AutomaticStyleBrief;
function resolveStyleBrief(style3, flag, file) {
  if (style3.id !== CustomStyle.id) {
    if (flag !== "" || file !== "") throw new Error(`--style-brief / --style-brief-file \u53EA\u80FD\u4E0E --style ${CustomStyleFlag} \u4E00\u8D77\u4F7F\u7528`);
    return "";
  }
  let raw;
  if (flag !== "" && file !== "") throw new Error("--style-brief \u4E0E --style-brief-file \u53EA\u80FD\u4E8C\u9009\u4E00");
  else if (flag !== "") raw = flag;
  else if (file !== "") {
    try {
      raw = import_node_fs12.default.readFileSync(file, "utf8");
    } catch (err) {
      throw new Error(`\u8BFB\u53D6\u98CE\u683C\u63CF\u8FF0\u6587\u4EF6\u5931\u8D25\uFF1A${goPathError("open", file, err)}`);
    }
  } else return defaultStyleBrief;
  const brief = raw.trim();
  if (brief === "") throw new Error("\u98CE\u683C\u63CF\u8FF0\u4E0D\u80FD\u4E3A\u7A7A");
  const n = [...brief].length;
  if (n > maxStyleBriefRunes) throw new Error(`\u98CE\u683C\u63CF\u8FF0\u8FC7\u957F\uFF08${n} \u5B57\uFF0C\u4E0A\u9650 ${maxStyleBriefRunes}\uFF09`);
  return brief;
}
function styleBriefDocument(brief) {
  return "# \u65E7\u7248\u98CE\u683C\u63CF\u8FF0\uFF08\u517C\u5BB9\u6587\u4EF6\uFF09\n\n> \u7531\u65E7\u7248 `am init` \u5199\u5165\uFF0C\u4EC5\u4F9B\u5B58\u91CF\u9879\u76EE\u53C2\u8003\u3002\u65B0\u955C\u5934\u7684\u914D\u8272\u3001\u5B57\u4F53\u3001\u7248\u5F0F\u3001\u6750\u8D28\u4E0E\u52A8\u6548\u7531\u955C\u5934\u81EA\u884C\u51B3\u5B9A\uFF1B\u6539\u52A8\u672C\u6587\u4EF6\u4E0D\u4F1A\u5F62\u6210\u6E32\u67D3\u8981\u6C42\u3002\n\n" + brief + "\n";
}

// src/filmstyle.ts
function sourceSummary() {
  return sources().map((source) => {
    let line2 = "  " + source.id() + "  " + source.name();
    if (source.gallery() !== "") line2 += "\uFF0C\u56FE\u9274 " + source.gallery();
    return line2;
  }).join("\n");
}
function manifestJSON(m) {
  return { source: m.source, slug: m.slug, cn: m.cn, en: m.en, version: m.version, digest: m.digest, installed_at: m.installed_at };
}
function shortCommit(commit) {
  return commit.length > 12 ? commit.slice(0, 12) : commit;
}
function newFilmStyleCommand(stdout, _stderr) {
  const projectRoot = ref("");
  const filmCmd = new Command({
    use: "film-style",
    short: "\u6574\u7247\u98CE\u683C\uFF1A\u4ECE\u98CE\u683C\u6765\u6E90\u91CC\u6311\u4E00\u79CD\u753B\u9762\u98CE\u683C\u7528\u4E8E\u5168\u7247",
    long: `\u6574\u7247\u98CE\u683C\u662F\u53EF\u9009\u7684\u3002\u9879\u76EE\u6CA1\u6709\u6574\u7247\u98CE\u683C\u65F6\uFF0C\u6BCF\u4E2A\u955C\u5934\u81EA\u4E3B\u51B3\u5B9A\u89C6\u89C9\uFF1B\u88C5\u4E86\u6574\u7247\u98CE\u683C\u540E\uFF0C
\u6240\u6709\u955C\u5934\u753B\u6210\u540C\u4E00\u79CD\u98CE\u683C\uFF1A\u955C\u5934\u63D0\u793A\u8BCD\u628A\u300C\u89C6\u89C9\u81EA\u7531\u5EA6\u300D\u6362\u6210\u300C\u6574\u7247\u98CE\u683C\u300D\uFF0C\u6E32\u67D3\u5668\u5FC5\u987B
\u9075\u5B88\u8BE5\u98CE\u683C STYLE.md \u7684\u4E0D\u53D8\u91CF\uFF0C\u6545\u4E8B\u4E0E\u5185\u5BB9\u4ECD\u6765\u81EA\u6BCF\u4E2A\u955C\u5934\u81EA\u5DF1\u7684\u6587\u6848\u3002

\u98CE\u683C\u6765\u81EA\u98CE\u683C\u6765\u6E90\uFF0C\u6BCF\u79CD\u98CE\u683C\u7684\u6807\u8BC6\u662F\u300C\u6765\u6E90/\u76EE\u5F55\u540D\u300D\uFF1B\u540D\u5B57\u5728\u5404\u6765\u6E90\u91CC\u552F\u4E00\u65F6\u4E5F\u53EF\u4EE5\u53EA\u5199
\u76EE\u5F55\u540D\u3001\u4E2D\u6587\u540D\u6216\u82F1\u6587\u540D\u3002\u5DF2\u767B\u8BB0\u7684\u6765\u6E90\uFF1A
` + sourceSummary() + `

\u88C5\u8FDB\u9879\u76EE\u7684\u843D\u5728 .agents/skills/` + SkillName + `/\uFF1ASTYLE.md\uFF08\u4E0D\u53D8\u91CF\uFF09\u3001SKILL.md\uFF08\u600E\u4E48\u7528\u3001
\u6280\u6CD5\u53C2\u8003\u5728\u54EA\uFF09\u4E0E ` + ManifestFile2 + `\uFF08\u6765\u6E90\u4E0E\u7248\u672C\uFF09\uFF0C\u9879\u76EE\u6574\u4F53\u62F7\u8D70\u4E5F\u80FD\u6E32\u67D3\u3002
\u5404\u6765\u6E90\u7684\u6570\u636E\u662F\u524D\u7F6E\u8D44\u6E90\uFF0C\u7531 am setup \u4E0B\u8F7D\uFF1B\u672C\u7EC4\u547D\u4EE4\u90FD\u4E0D\u8054\u7F51\u3002`
  });
  filmCmd.persistentFlags().stringVar(projectRoot, "project-root", "", "\u9879\u76EE\u6839\u76EE\u5F55\uFF0C\u7F3A\u7701\u4E3A\u5F53\u524D\u76EE\u5F55");
  const root = () => {
    const abs = import_node_path12.default.resolve(projectRoot.value || ".");
    if (!import_node_fs13.default.existsSync(import_node_path12.default.join(abs, "article-to-motion.conf"))) {
      throw new Error(`${abs} \u4E0D\u662F am \u9879\u76EE\uFF08\u7F3A\u5C11 article-to-motion.conf\uFF09\uFF0C\u7528 --project-root \u6307\u5411\u9879\u76EE\u6839\u76EE\u5F55`);
    }
    return abs;
  };
  const listJSON = ref(false);
  const listSource = ref("");
  const listCmd = new Command({
    use: "list",
    args: noArgs,
    short: "\u5217\u51FA\u5404\u98CE\u683C\u6765\u6E90\u91CC\u7684\u5168\u90E8\u98CE\u683C",
    long: `\u6309\u6765\u6E90\u3001\u518D\u6309\u5206\u7C7B\u5217\u51FA\u5168\u90E8\u98CE\u683C\uFF1A\u6807\u8BC6\uFF08\u6765\u6E90/\u76EE\u5F55\u540D\uFF09\u3001\u4E2D\u6587\u540D\u3001\u82F1\u6587\u540D\u3001\u9002\u7528\u9898\u6750\u4E0E\u8BF4\u660E\u3002
\u4E0D\u8054\u7F51\u3002--source \u53EA\u5217\u4E00\u4E2A\u6765\u6E90\uFF1B--json \u8F93\u51FA\u673A\u5668\u53EF\u8BFB\u7684\u5217\u8868\u3002`,
    example: `  am film-style list
  am film-style list --source lemo-opuscar
  am film-style list --json`,
    runE: () => {
      let sources2 = sources();
      if (listSource.value !== "") {
        const source = sourceByID(listSource.value);
        if (!source) throw new Error(`\u6CA1\u6709\u98CE\u683C\u6765\u6E90 ${goQuote(listSource.value)}\u3002\u5DF2\u767B\u8BB0\uFF1A
${sourceSummary()}`);
        sources2 = [source];
      }
      if (listJSON.value) {
        const styles = sources2.flatMap((source) => source.catalog());
        stdout.write(encodeLine(styles.length ? styles : null, { indent: "  " }));
        return;
      }
      let current = "";
      try {
        const { manifest, ok } = installed(root());
        if (ok) current = manifestKey(manifest);
      } catch {
      }
      for (const source of sources2) {
        stdout.write(`== ${source.id()}  ${source.name()}
`);
        if (source.gallery() !== "") stdout.write(`   \u56FE\u9274\uFF1A${source.gallery()}
`);
        const catalog3 = source.catalog();
        for (const category of categories(source.id())) {
          stdout.write(`${category}
`);
          for (const style3 of catalog3) {
            if (style3.category_cn !== category) continue;
            const mark = styleKey(style3) === current ? "*" : " ";
            const extra = style3.tags && style3.tags.length > 0 ? "  [" + style3.tags.join(", ") + "]" : "";
            stdout.write(` ${mark} ${padRight(styleKey(style3), 34)} ${style3.cn} ${style3.en}${extra}
`);
            stdout.write(`      \u9002\u5408\uFF1A${(style3.uses ?? []).join(", ")}\uFF1B${style3.summary}
`);
          }
        }
        stdout.write("\n");
      }
      if (current !== "") stdout.write("* \u4E3A\u672C\u9879\u76EE\u5F53\u524D\u7684\u6574\u7247\u98CE\u683C\n");
    }
  });
  listCmd.flags().boolVar(listJSON, "json", false, "\u4EE5 JSON \u8F93\u51FA");
  listCmd.flags().stringVar(listSource, "source", "", "\u53EA\u5217\u4E00\u4E2A\u98CE\u683C\u6765\u6E90");
  filmCmd.addCommand(listCmd);
  const replace = ref(false);
  const useCmd = new Command({
    use: "use STYLE",
    args: exactArgs(1, "STYLE"),
    short: "\u628A\u4E00\u79CD\u98CE\u683C\u88C5\u6210\u672C\u9879\u76EE\u7684\u6574\u7247\u98CE\u683C",
    long: `STYLE \u5199\u6210\u300C\u6765\u6E90/\u76EE\u5F55\u540D\u300D\uFF0C\u6216\u8005\u5728\u5404\u6765\u6E90\u91CC\u552F\u4E00\u7684\u76EE\u5F55\u540D\u3001\u4E2D\u6587\u540D\u3001\u82F1\u6587\u540D\u3002\u4E0D\u8054\u7F51\uFF1A
\u6765\u6E90\u6570\u636E\u662F\u524D\u7F6E\u8D44\u6E90\uFF0C\u5148\u8FD0\u884C am setup \u51C6\u5907\u597D\uFF0C\u8FD9\u91CC\u53EA\u88C5\u8FDB\u9879\u76EE\u3002

\u9879\u76EE\u5DF2\u6709\u53E6\u4E00\u79CD\u6574\u7247\u98CE\u683C\u65F6\u9ED8\u8BA4\u62D2\u7EDD\uFF1A\u6362\u98CE\u683C\u4F1A\u8BA9\u5168\u90E8\u955C\u5934\u7684\u8F93\u5165\u6307\u7EB9\u53D8\u5316\uFF0C
\u5DF2\u6E32\u67D3\u7684\u955C\u5934\u90FD\u8981\u91CD\u6E32\u67D3\u3002\u786E\u8BA4\u8981\u6362\u5C31\u52A0 --replace\u3002\u540C\u4E00\u79CD\u98CE\u683C\u91CD\u590D\u6267\u884C\u662F\u5E42\u7B49\u7684\u3002`,
    example: `  am film-style use lemo-opuscar/impasto
  am film-style use \u6CB9\u753B\u539A\u6D82
  am film-style use "Swiss Motion Graphics" --replace`,
    runE: (_cmd, args) => {
      const dir = root();
      const style3 = lookup(args[0]);
      const result = install2({ projectDir: dir, style: style3, env: currentEnvironment(), replace: replace.value });
      reportFilmStyle(stdout, style3, result);
    }
  });
  useCmd.flags().boolVar(replace, "replace", false, "\u5141\u8BB8\u6362\u6389\u9879\u76EE\u5DF2\u6709\u7684\u53E6\u4E00\u79CD\u6574\u7247\u98CE\u683C");
  filmCmd.addCommand(useCmd);
  const showJSON = ref(false);
  const showCmd = new Command({
    use: "show",
    args: noArgs,
    short: "\u663E\u793A\u672C\u9879\u76EE\u7684\u6574\u7247\u98CE\u683C\u4E0E\u5404\u98CE\u683C\u6765\u6E90\u7684\u72B6\u6001",
    long: `\u663E\u793A\u672C\u9879\u76EE\u88C5\u7684\u6574\u7247\u98CE\u683C\uFF08\u6765\u6E90\u3001\u540D\u5B57\u3001\u7248\u672C\u3001\u6280\u80FD\u76EE\u5F55\uFF09\uFF0C\u4EE5\u53CA\u5404\u98CE\u683C\u6765\u6E90\u7684\u6570\u636E\u662F\u5426\u5DF2\u7531
am setup \u51C6\u5907\u597D\u3002\u4E0D\u8054\u7F51\u3001\u4E0D\u6539\u4EFB\u4F55\u6587\u4EF6\u3002--json \u8F93\u51FA\u673A\u5668\u53EF\u8BFB\u7684\u540C\u4E00\u4EFD\u4FE1\u606F\u3002`,
    example: `  am film-style show
  am film-style show --json`,
    runE: () => {
      const dir = root();
      const { manifest, ok: isInstalled } = installed(dir);
      const env = currentEnvironment();
      const skillDirPath = isInstalled ? installedDir(dir) : "";
      const sources2 = sources().map((source) => {
        let ready = true;
        let problem = "";
        try {
          source.check(env);
        } catch (err) {
          ready = false;
          problem = err.message;
        }
        return { id: source.id(), name: source.name(), location: source.location(env), ready, problem: problem || void 0 };
      });
      if (showJSON.value) {
        stdout.write(
          encodeLine(
            {
              installed: isInstalled,
              style: isInstalled ? manifestJSON(manifest) : void 0,
              skill_dir: skillDirPath || void 0,
              sources: sources2.length ? sources2 : null
            },
            { indent: "  " }
          )
        );
        return;
      }
      if (isInstalled) {
        stdout.write(`\u6574\u7247\u98CE\u683C\uFF1A${manifest.cn} ${manifest.en}\uFF08${manifestKey(manifest)}\uFF09\uFF0C\u7248\u672C ${shortCommit(manifest.version)}
\u6280\u80FD\u76EE\u5F55\uFF1A${skillDirPath}
`);
        if (manifest.legacy) stdout.write("\uFF08\u65E7\u7248\u76EE\u5F55\uFF1B\u518D\u8FD0\u884C\u4E00\u6B21 am film-style use \u4F1A\u6362\u6210\u65B0\u76EE\u5F55\uFF09\n");
      } else {
        stdout.write("\u6574\u7247\u98CE\u683C\uFF1A\u65E0\uFF08\u5404\u955C\u5934\u81EA\u4E3B\u5B9A\u89C6\u89C9\uFF09\u3002\u7528 am film-style list \u67E5\u770B\u53EF\u9009\u98CE\u683C\n");
      }
      for (const item of sources2) {
        const state = item.ready ? "\u5DF2\u5C31\u7EEA" : "\u672A\u51C6\u5907\uFF08\u8FD0\u884C am setup\uFF09";
        stdout.write(`\u98CE\u683C\u6765\u6E90 ${item.id}\uFF1A${state}\uFF0C${item.location}
`);
      }
    }
  });
  showCmd.flags().boolVar(showJSON, "json", false, "\u4EE5 JSON \u8F93\u51FA");
  filmCmd.addCommand(showCmd);
  filmCmd.addCommand(
    new Command({
      use: "remove",
      args: noArgs,
      short: "\u53BB\u6389\u672C\u9879\u76EE\u7684\u6574\u7247\u98CE\u683C\uFF0C\u56DE\u5230\u5404\u955C\u5934\u81EA\u4E3B\u5B9A\u89C6\u89C9",
      long: `\u5220\u9664 .agents/skills/` + SkillName + `/\uFF08\u4EE5\u53CA\u65E7\u7248\u76EE\u5F55\uFF09\u3002\u955C\u5934\u63D0\u793A\u8BCD\u968F\u4E4B\u56DE\u5230\u300C\u89C6\u89C9\u81EA\u7531\u5EA6\u300D\uFF0C
\u5DF2\u6E32\u67D3\u7684\u955C\u5934\u8F93\u5165\u6307\u7EB9\u53D8\u5316\u3001\u4F1A\u88AB\u5224\u4E3A Stale\uFF0C\u8981\u91CD\u6E32\u67D3\u3002\u98CE\u683C\u6765\u6E90\u7684\u6570\u636E\u4E0D\u52A8\u3002`,
      example: "  am film-style remove",
      runE: () => {
        const { manifest, had } = remove(root());
        if (!had) {
          stdout.write("\u672C\u9879\u76EE\u6CA1\u6709\u6574\u7247\u98CE\u683C\n");
          return;
        }
        stdout.write(`\u5DF2\u53BB\u6389\u6574\u7247\u98CE\u683C ${manifest.cn} ${manifest.en}\uFF1B\u5DF2\u6E32\u67D3\u7684\u955C\u5934\u4F1A\u88AB\u5224\u4E3A Stale
`);
      }
    })
  );
  return filmCmd;
}
function reportFilmStyle(stdout, style3, result) {
  if (result.unchanged) stdout.write(`\u6574\u7247\u98CE\u683C\u5DF2\u662F ${styleLabel(style3)}\uFF0C\u672A\u6539\u52A8
`);
  else if (result.replaced) stdout.write(`\u6574\u7247\u98CE\u683C\u5DF2\u4ECE ${result.replaced} \u6362\u6210 ${styleLabel(style3)}\uFF1B\u5DF2\u6E32\u67D3\u7684\u955C\u5934\u4F1A\u88AB\u5224\u4E3A Stale
`);
  else stdout.write(`\u6574\u7247\u98CE\u683C\u5DF2\u8BBE\u4E3A ${styleLabel(style3)}\uFF08\u7248\u672C ${shortCommit(result.manifest.version)}\uFF09
`);
}

// src/hyperframes.ts
var import_node_child_process3 = require("node:child_process");
function newHyperframesCommand(stdout, stderr) {
  return new Command({
    use: "hyperframes [ARGS...]",
    short: "\u8FD0\u884C am \u7BA1\u7406\u7684\u56FA\u5B9A\u7248\u672C HyperFrames CLI",
    long: `\u7528\u56FA\u5B9A\u7248\u672C ` + hyperframesVersion + ` \u7684 HyperFrames CLI \u6267\u884C ARGS\uFF0C\u5DE5\u4F5C\u76EE\u5F55\u4E0D\u53D8\uFF0C\u9000\u51FA\u7801\u900F\u4F20\u3002

CLI \u662F\u524D\u7F6E\u8D44\u6E90\uFF0C\u7531 am setup \u88C5\u5728\u7528\u6237\u7EA7\u76EE\u5F55\uFF08\u9ED8\u8BA4 ~/.local/share/am/hyperframes/cli-` + hyperframesVersion + `\uFF0C
\u53EF\u7528 ` + CLIDirEnv + ` \u6307\u5B9A\uFF09\uFF0C\u6240\u6709\u9879\u76EE\u5171\u7528\u3002\u8FD9\u91CC\u53EA\u7528\u4E0D\u88C5\uFF1A\u6CA1\u88C5\u597D\u5C31\u62A5\u9519\uFF0C
\u63D0\u793A\u5148\u8FD0\u884C am setup\u3002

\u6E32\u67D3\u5668\u548C\u7F16\u6392\u5DE5\u5177\u8C03\u7528 CLI \u4E00\u5F8B\u5199\u6210 am hyperframes <\u5B50\u547D\u4EE4>\uFF0C\u4E0D\u8981\u7528 npx\uFF1Anpx \u4F1A\u5728
\u6E32\u67D3\u9014\u4E2D\u73B0\u4E0B\u8F7D\uFF0C\u7F51\u7EDC\u4E0D\u597D\u65F6\u6574\u6B21\u6E32\u67D3\u767D\u8DD1\u3002`,
    example: `  am hyperframes lint
  am hyperframes check --json
  am hyperframes snapshot --at 1.5 --describe false
  am hyperframes render`,
    disableFlagParsing: true,
    runE: (cmd, args) => {
      const env = currentEnvironment();
      const dir = requireCLI(env);
      const spec = cliCommandFor(dir, env, args);
      return new Promise((resolve3, reject) => {
        const child = (0, import_node_child_process3.spawn)(spec.file, spec.args, { env: spec.env, stdio: ["inherit", "pipe", "pipe"], signal: cmd.context() });
        child.stdout.on("data", (chunk) => stdout.write(String(chunk)));
        child.stderr.on("data", (chunk) => stderr.write(String(chunk)));
        child.on("error", reject);
        child.on("close", (code) => {
          if (code === 0) resolve3();
          else if (code !== null) reject(new ExitError2(code, `hyperframes \u9000\u51FA\u7801 ${code}`));
          else reject(new Error("signal: killed"));
        });
      });
    }
  });
}

// src/align.ts
var import_node_fs17 = __toESM(require("node:fs"), 1);
var import_node_path13 = __toESM(require("node:path"), 1);

// ../engine/src/align/script.ts
var import_node_fs14 = __toESM(require("node:fs"), 1);

// ../engine/src/align/token.ts
function runes(s) {
  const out = [];
  for (const ch of s) out.push(ch.codePointAt(0));
  return out;
}
function runeString(rs) {
  let out = "";
  for (const r of rs) out += String.fromCodePoint(r);
  return out;
}
var cjkPattern = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u;
var letterPattern = new RegExp("^\\p{L}$", "u");
var digitPattern = new RegExp("^\\p{Nd}$", "u");
var markPattern = new RegExp("^\\p{Mn}$", "u");
function isLetter(r) {
  if (r < 128) return r >= 65 && r <= 90 || r >= 97 && r <= 122;
  return letterPattern.test(String.fromCodePoint(r));
}
function isDigit(r) {
  if (r < 128) return r >= 48 && r <= 57;
  return digitPattern.test(String.fromCodePoint(r));
}
function isMark(r) {
  return r >= 768 && markPattern.test(String.fromCodePoint(r));
}
function isCJK(r) {
  return r >= 4352 && cjkPattern.test(String.fromCodePoint(r));
}
function toLower(r) {
  if (r < 128) return r >= 65 && r <= 90 ? r + 32 : r;
  if (r === 304) return 105;
  const lower = String.fromCodePoint(r).toLowerCase();
  const cps = runes(lower);
  return cps.length === 1 ? cps[0] : r;
}
function normRune(r) {
  if (r >= 65281 && r <= 65374) r -= 65248;
  else if (r === 12288) r = 32;
  return toLower(r);
}
function isWordRune(r) {
  return !isCJK(r) && (isLetter(r) || isDigit(r));
}
function isJoiner(r) {
  return r === 39 || r === 46 || r === 45 || r === 8217;
}
function tokenizeRunes(rs) {
  const spans = [];
  for (let i = 0; i < rs.length; ) {
    const r = normRune(rs[i]);
    if (isCJK(r)) {
      spans.push({ start: i, end: i + 1 });
      i++;
    } else if (isWordRune(r)) {
      let j = i + 1;
      while (j < rs.length) {
        const next = normRune(rs[j]);
        if (isWordRune(next)) {
          j++;
          continue;
        }
        if (isJoiner(next) && j + 1 < rs.length && isWordRune(normRune(rs[j + 1]))) {
          j += 2;
          continue;
        }
        break;
      }
      spans.push({ start: i, end: j });
      i = j;
    } else {
      i++;
    }
  }
  return spans;
}
function normalizeRunes(rs) {
  const out = [];
  for (let r of rs) {
    r = normRune(r);
    if (isLetter(r) || isDigit(r) || isMark(r)) out.push(r);
  }
  return runeString(out);
}
function tokenize2(text) {
  const rs = runes(text);
  return tokenizeRunes(rs).map((s) => ({ text: runeString(rs.slice(s.start, s.end)), norm: normalizeRunes(rs.slice(s.start, s.end)) }));
}

// ../engine/src/align/script.ts
var phraseIDPattern = /^[a-z0-9][a-z0-9_-]*$/;
var ParseError = class extends Error {
  constructor(line2, col, msg) {
    super(`\u7B2C ${line2} \u884C\u7B2C ${col} \u5217\uFF1A${msg}`);
    this.line = line2;
    this.col = col;
    this.msg = msg;
  }
  line;
  col;
  msg;
};
var badEscape = "\u65E0\u6548\u8F6C\u4E49\uFF1A\u53EA\u80FD\u8F6C\u4E49 \\< \\> \\@ \\| \\\\";
var Script = class {
  pieces = [];
  tokens = [];
  phrases = [];
  /** pieceToken 是每个 piece 上第一个开始的朗读单元下标，没有时为 -1。 */
  pieceToken = [];
  /** headings 是标题行，只给 view 用：不进配音、不进字幕。 */
  headings = [];
  /** SpokenText 返回送进 TTS 与对齐工具的文本：标记取朗读侧，标题行丢掉，段与段之间换行，标点保留。 */
  spokenText() {
    let b = "";
    this.pieces.forEach((p, i) => {
      if (i > 0 && p.para !== this.pieces[i - 1].para) b += "\n";
      b += p.spoken;
    });
    const out = [];
    for (const para of b.split("\n")) {
      const t = goTrimSpace(para);
      if (t !== "") out.push(t);
    }
    if (out.length === 0) return "";
    return out.join("\n") + "\n";
  }
  /** displayText 拼出 piece 区间 [from, to) 的显示文本。 */
  displayText(from, to) {
    let b = "";
    for (const p of this.pieces.slice(from, to)) b += p.display;
    return goTrimSpace(b);
  }
  /**
   * tokenRange 返回首 piece 落在 [from, to) 内的朗读单元下标区间，左闭右开。
   * 区间里没有朗读单元时返回空区间 (k, k)，k 是其后第一个单元的下标。
   */
  tokenRange(from, to) {
    const first = search(this.tokens.length, (i) => this.tokens[i].firstPiece >= from);
    const end = search(this.tokens.length, (i) => this.tokens[i].firstPiece >= to);
    return [first, Math.max(first, end)];
  }
};
function search(n, f) {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = lo + hi >>> 1;
    if (!f(mid)) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
function loadScript(file) {
  let body;
  try {
    body = import_node_fs14.default.readFileSync(file, "utf8");
  } catch (err) {
    throw new Error(`\u65E0\u6CD5\u8BFB\u53D6\u7EC8\u7A3F\uFF1A${goPathError("open", file, err)}`, { cause: err });
  }
  try {
    return parseScript(body);
  } catch (err) {
    throw new Error(`${file} ${err.message}`, { cause: err });
  }
}
function trimLeftSet(s, cutset) {
  const set = new Set(cutset);
  const cs = [...s];
  let i = 0;
  while (i < cs.length && set.has(cs[i])) i++;
  return cs.slice(i).join("");
}
function trimRightSet(s, cutset) {
  const set = new Set(cutset);
  const cs = [...s];
  let end = cs.length;
  while (end > 0 && set.has(cs[end - 1])) end--;
  return cs.slice(0, end).join("");
}
function parseScript(text) {
  const s = new Script();
  if (text.startsWith("\uFEFF")) text = text.slice(1);
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  const stack = [];
  const seen = /* @__PURE__ */ new Set();
  let para = 0;
  let paraHasContent = false;
  lines.forEach((raw, index) => {
    const lineNo = index + 1;
    const line2 = trimRightSet(raw, "\r");
    const trimmed = trimLeftSet(line2, " 	\u3000");
    if (goTrimSpace(trimmed) === "" || trimmed.startsWith("#")) {
      if (trimmed.startsWith("#")) {
        const body = trimLeftSet(trimmed, "#");
        s.headings.push({ atPiece: s.pieces.length, level: trimmed.length - body.length, text: goTrimSpace(body) });
      }
      if (paraHasContent) {
        para++;
        paraHasContent = false;
      }
      return;
    }
    if (paraHasContent) s.pieces.push({ display: "", spoken: "", line: lineNo, col: 1, para, plain: false, softBreak: true });
    paraHasContent = true;
    const rs = runes(line2);
    const add = (p) => s.pieces.push({ ...p, para, softBreak: false });
    for (let i = 0; i < rs.length; ) {
      const col = i + 1;
      const r = rs[i];
      if (r === 92) {
        if (i + 1 >= rs.length || !isEscapable(rs[i + 1])) throw new ParseError(lineNo, col, badEscape);
        const ch = String.fromCodePoint(rs[i + 1]);
        add({ display: ch, spoken: ch, line: lineNo, col, plain: true });
        i += 2;
      } else if (r === 60) {
        const [display, spoken, next] = parseAlternative(rs, i, lineNo);
        add({ display, spoken, line: lineNo, col, plain: false });
        i = next;
      } else if (r === 64 && i + 1 < rs.length && rs[i + 1] === 123) {
        const end = indexRune(rs, i + 2, 125);
        if (end < 0) throw new ParseError(lineNo, col, "\u77ED\u8BED\u6807\u8BB0\u7F3A\u5C11 }");
        const body = runeString(rs.slice(i + 2, end));
        if (body.startsWith("/")) {
          const id = body.slice(1);
          if (stack.length === 0) throw new ParseError(lineNo, col, `@{/${id}} \u6CA1\u6709\u5BF9\u5E94\u7684 @{${id}}`);
          const top = stack[stack.length - 1];
          if (top.id !== id) {
            throw new ParseError(lineNo, col, `@{/${id}} \u4E0E\u672A\u95ED\u5408\u7684 @{${top.id}}\uFF08\u7B2C ${top.line} \u884C\u7B2C ${top.col} \u5217\uFF09\u4EA4\u53C9\uFF1A\u77ED\u8BED\u53EA\u80FD\u5D4C\u5957\uFF0C\u4E0D\u80FD\u4EA4\u53C9`);
          }
          stack.pop();
          if (top.startPiece === s.pieces.length) throw new ParseError(top.line, top.col, `\u77ED\u8BED ${id} \u662F\u7A7A\u7684`);
          s.phrases.push({ id, startPiece: top.startPiece, endPiece: s.pieces.length, line: top.line, col: top.col, order: 0 });
        } else {
          if (!phraseIDPattern.test(body)) {
            throw new ParseError(lineNo, col, `\u77ED\u8BED id ${goQuote(body)} \u4E0D\u5408\u6CD5\uFF1A\u53EA\u80FD\u7528\u5C0F\u5199\u5B57\u6BCD\u3001\u6570\u5B57\u3001_ \u548C -\uFF0C\u4E14\u4EE5\u5B57\u6BCD\u6216\u6570\u5B57\u5F00\u5934`);
          }
          if (seen.has(body)) throw new ParseError(lineNo, col, `\u77ED\u8BED id ${body} \u91CD\u590D`);
          seen.add(body);
          stack.push({ id: body, startPiece: s.pieces.length, line: lineNo, col });
        }
        i = end + 1;
      } else {
        const ch = String.fromCodePoint(r);
        add({ display: ch, spoken: ch, line: lineNo, col, plain: true });
        i++;
      }
    }
  });
  if (stack.length > 0) {
    const top = stack[stack.length - 1];
    throw new ParseError(top.line, top.col, `\u77ED\u8BED @{${top.id}} \u6CA1\u6709\u95ED\u5408`);
  }
  resolveSoftBreaks(s);
  sortPhrases(s);
  tokenizeScript(s);
  return s;
}
function isEscapable(r) {
  return r === 60 || r === 62 || r === 64 || r === 124 || r === 92;
}
function indexRune(rs, from, target) {
  for (let i = from; i < rs.length; i++) if (rs[i] === target) return i;
  return -1;
}
function parseAlternative(rs, start, lineNo) {
  const parts = [[], []];
  let part = 0;
  for (let i = start + 1; i < rs.length; i++) {
    const r = rs[i];
    switch (r) {
      case 92:
        if (i + 1 >= rs.length || !isEscapable(rs[i + 1])) throw new ParseError(lineNo, i + 1, badEscape);
        parts[part].push(rs[i + 1]);
        i++;
        break;
      case 124:
        if (part === 1) throw new ParseError(lineNo, i + 1, "<\u663E\u793A|\u6717\u8BFB> \u91CC\u53EA\u80FD\u6709\u4E00\u4E2A |\uFF0C\u5B57\u9762\u7684 | \u5199\u6210 \\|");
        part = 1;
        break;
      case 60:
        throw new ParseError(lineNo, i + 1, "<\u663E\u793A|\u6717\u8BFB> \u4E0D\u80FD\u5D4C\u5957\uFF0C\u5B57\u9762\u7684 < \u5199\u6210 \\<");
      case 62: {
        if (part === 0) throw new ParseError(lineNo, start + 1, "<\u663E\u793A|\u6717\u8BFB> \u7F3A\u5C11 |\uFF1B\u5B57\u9762\u7684 < \u5199\u6210 \\<");
        const display = runeString(parts[0]);
        const spoken = runeString(parts[1]);
        if (display === "" && spoken === "") throw new ParseError(lineNo, start + 1, "<|> \u4E24\u4FA7\u90FD\u662F\u7A7A\u7684");
        return [display, spoken, i + 1];
      }
      default:
        parts[part].push(r);
    }
  }
  throw new ParseError(lineNo, start + 1, "<\u663E\u793A|\u6717\u8BFB> \u6CA1\u6709\u5728\u672C\u884C\u95ED\u5408");
}
function resolveSoftBreaks(s) {
  for (let i = 0; i < s.pieces.length; i++) {
    if (!s.pieces[i].softBreak || i === 0 || i + 1 >= s.pieces.length) continue;
    const before = runes(s.pieces[i - 1].spoken);
    const after = runes(s.pieces[i + 1].spoken);
    if (before.length > 0 && after.length > 0 && isWordRune(normRune(before[before.length - 1])) && isWordRune(normRune(after[0]))) {
      s.pieces[i].display = " ";
      s.pieces[i].spoken = " ";
    }
  }
}
function sortPhrases(s) {
  const phrases = s.phrases;
  for (let i = 1; i < phrases.length; i++) {
    for (let j = i; j > 0 && phraseBefore(phrases[j], phrases[j - 1]); j--) {
      [phrases[j], phrases[j - 1]] = [phrases[j - 1], phrases[j]];
    }
  }
  phrases.forEach((p, i) => p.order = i + 1);
}
function phraseBefore(a, b) {
  if (a.startPiece !== b.startPiece) return a.startPiece < b.startPiece;
  if (a.line !== b.line) return a.line < b.line;
  return a.col < b.col;
}
function tokenizeScript(s) {
  s.pieceToken = new Array(s.pieces.length).fill(-1);
  for (let start = 0; start < s.pieces.length; ) {
    let end = start;
    while (end < s.pieces.length && s.pieces[end].para === s.pieces[start].para) end++;
    const rs = [];
    const owner = [];
    for (let p = start; p < end; p++) {
      for (const r of runes(s.pieces[p].spoken)) {
        rs.push(r);
        owner.push(p);
      }
    }
    for (const sp of tokenizeRunes(rs)) {
      const first = owner[sp.start];
      const last = owner[sp.end - 1];
      if (s.pieceToken[first] < 0) s.pieceToken[first] = s.tokens.length;
      s.tokens.push({
        text: runeString(rs.slice(sp.start, sp.end)),
        norm: normalizeRunes(rs.slice(sp.start, sp.end)),
        firstPiece: first,
        lastPiece: last,
        line: s.pieces[first].line,
        col: s.pieces[first].col
      });
    }
    start = end;
  }
}

// ../engine/src/align/match.ts
var LabelExact = "exact";
var LabelSplit = "split";
var LabelMerge = "merge";
var LabelReplace = "replacement";
var LabelOmission = "source-omission";
var LabelInsertion = "evidence-insertion";
var omissionCost = 0.5;
var insertionCost = 0.35;
var regroupCost = 0.055;
var maxGroup = 4;
var costEpsilon = 1e-9;
var evidenceTrust = 0.8;
var boundaryCost = 0.06;
var minBandHalfWidth = 128;
var beamWidth = 15;
var Band = class {
  lo;
  hi;
  offset;
  cost;
  exact;
  omissions;
  insertions;
  complexity;
  prevS;
  prevE;
  ok;
  constructor(n, m) {
    const half = minBandHalfWidth + Math.abs(n - m);
    this.lo = new Int32Array(n + 1);
    this.hi = new Int32Array(n + 1);
    this.offset = new Int32Array(n + 1);
    let total = 0;
    for (let i = 0; i <= n; i++) {
      const center = n > 0 ? Math.floor(i * m / n) : m;
      this.lo[i] = Math.max(0, center - half);
      this.hi[i] = Math.min(m, center + half);
      this.offset[i] = total - this.lo[i];
      total += this.hi[i] - this.lo[i] + 1;
    }
    this.cost = new Float64Array(total);
    this.exact = new Int32Array(total);
    this.omissions = new Int32Array(total);
    this.insertions = new Int32Array(total);
    this.complexity = new Int32Array(total);
    this.prevS = new Int32Array(total);
    this.prevE = new Int32Array(total);
    this.ok = new Uint8Array(total);
  }
  /** 格子的下标，不在带内时返回 -1（Go 的 at 返回 nil）。 */
  at(i, j) {
    if (j < this.lo[i] || j > this.hi[i]) return -1;
    return this.offset[i] + j;
  }
};
function better(candidate2, b, current) {
  if (!b.ok[current]) return true;
  const cost = b.cost[current];
  if (candidate2.cost < cost - costEpsilon) return true;
  if (candidate2.cost > cost + costEpsilon) return false;
  if (candidate2.exact !== b.exact[current]) return candidate2.exact > b.exact[current];
  if (candidate2.omissions !== b.omissions[current]) return candidate2.omissions < b.omissions[current];
  if (candidate2.insertions !== b.insertions[current]) return candidate2.insertions < b.insertions[current];
  return candidate2.complexity < b.complexity[current];
}
function byteLength(s) {
  return Buffer.byteLength(s, "utf8");
}
function matchTokens(source, evidence) {
  const n = source.length;
  const m = evidence.length;
  const b = new Band(n, m);
  const origin = b.at(0, 0);
  b.ok[origin] = 1;
  b.prevS[origin] = -1;
  b.prevE[origin] = -1;
  const [sourceBytes, sourceRunes] = prefixLengths(source);
  const [evidenceBytes, evidenceRunes] = prefixLengths(evidence);
  const sourceLen = source.map(byteLength);
  const evidenceLen = evidence.map(byteLength);
  const update = (i, j, ni, nj, cost, exact) => {
    const target = b.at(ni, nj);
    if (target < 0) return;
    const prev = b.at(i, j);
    const sc = ni - i;
    const ec = nj - j;
    const candidate2 = {
      cost: b.cost[prev] + cost,
      exact: b.exact[prev] + exact,
      omissions: b.omissions[prev],
      insertions: b.insertions[prev],
      complexity: b.complexity[prev] + Math.max(0, sc + ec - 2)
    };
    if (ec === 0) candidate2.omissions += sc;
    if (sc === 0) candidate2.insertions += ec;
    if (better(candidate2, b, target)) {
      b.cost[target] = candidate2.cost;
      b.exact[target] = candidate2.exact;
      b.omissions[target] = candidate2.omissions;
      b.insertions[target] = candidate2.insertions;
      b.complexity[target] = candidate2.complexity;
      b.prevS[target] = i;
      b.prevE[target] = j;
      b.ok[target] = 1;
    }
  };
  const pair = (i, j, sc, ec) => {
    let exact = 0;
    if (sc === 1 && ec === 1) {
      if (source[i] === evidence[j]) exact = 1;
    } else if (source[i] === evidence[j] || source[i + sc - 1] === evidence[j + ec - 1]) {
      return;
    } else if (sourceBytes[i + sc] - sourceBytes[i] !== evidenceBytes[j + ec] - evidenceBytes[j] || sourceLen[i] === evidenceLen[j]) {
      const target = b.at(i + sc, j + ec);
      if (target < 0) return;
      if (b.ok[target] && b.cost[b.at(i, j)] + fuzzyLowerBound(sc, ec, sourceRunes[i + sc] - sourceRunes[i], evidenceRunes[j + ec] - evidenceRunes[j]) > b.cost[target] + costEpsilon) {
        return;
      }
    }
    update(i, j, i + sc, j + ec, pairedCost(source.slice(i, i + sc), evidence.slice(j, j + ec)), exact);
  };
  const reachable = (i, j) => {
    if (i < 0 || j < 0) return false;
    const c = b.at(i, j);
    return c >= 0 && b.ok[c] === 1;
  };
  const rowBest = new Float64Array(n + 1);
  const rowSeen = new Uint8Array(n + 1);
  for (let ni = 0; ni <= n; ni++) {
    for (let nj = b.lo[ni]; nj <= b.hi[ni]; nj++) {
      if (ni > 0 || nj > 0) {
        if (reachable(ni - 1, nj - 1)) pair(ni - 1, nj - 1, 1, 1);
        if (reachable(ni - 1, nj)) update(ni - 1, nj, ni, nj, omissionCost, 0);
        if (reachable(ni, nj - 1)) update(ni, nj - 1, ni, nj, insertionCost, 0);
        const here = b.at(ni, nj);
        const far = ni > 0 && rowSeen[ni - 1] === 1 && b.ok[here] === 1 && b.cost[here] > rowBest[ni - 1] + beamWidth;
        for (let sc = 1; !far && sc <= maxGroup && sc <= ni; sc++) {
          for (let ec = 1; ec <= maxGroup && ec <= nj; ec++) {
            if ((sc > 1 || ec > 1) && reachable(ni - sc, nj - ec)) pair(ni - sc, nj - ec, sc, ec);
          }
        }
      }
      const c = b.at(ni, nj);
      if (!b.ok[c]) continue;
      if (!rowSeen[ni] || b.cost[c] < rowBest[ni]) {
        rowBest[ni] = b.cost[c];
        rowSeen[ni] = 1;
      }
      if (ni < n) {
        const run2 = exactRunLength(source[ni], evidence, nj);
        if (run2 > maxGroup) pair(ni, nj, 1, run2);
      }
      if (nj < m) {
        const run2 = exactRunLength(evidence[nj], source, ni);
        if (run2 > maxGroup) pair(ni, nj, run2, 1);
      }
    }
  }
  const groups = [];
  for (let i = n, j = m; i > 0 || j > 0; ) {
    const c = b.at(i, j);
    const pi = b.prevS[c];
    const pj = b.prevE[c];
    groups.push({ s0: pi, s1: i, e0: pj, e1: j, label: labelOf(source.slice(pi, i), evidence.slice(pj, j)) });
    i = pi;
    j = pj;
  }
  groups.reverse();
  return groups;
}
function labelOf(source, evidence) {
  if (source.length === 0) return LabelInsertion;
  if (evidence.length === 0) return LabelOmission;
  if (source.join("") !== evidence.join("")) return LabelReplace;
  if (source.length === 1 && evidence.length === 1) return LabelExact;
  if (source.length === 1) return LabelSplit;
  return LabelMerge;
}
function prefixLengths(values) {
  const bytes2 = new Array(values.length + 1).fill(0);
  const counts = new Array(values.length + 1).fill(0);
  values.forEach((v, i) => {
    bytes2[i + 1] = bytes2[i] + byteLength(v);
    counts[i + 1] = counts[i] + runes(v).length;
  });
  return [bytes2, counts];
}
function fuzzyLowerBound(sc, ec, sourceLen, evidenceLen) {
  const width = Math.max(sourceLen, evidenceLen, 1);
  const distance = Math.abs(sourceLen - evidenceLen) / width;
  return distance * evidenceTrust * Math.max(sc, ec) + regroupCost * (sc + ec - 2) + boundaryCost * Math.abs(sc - ec);
}
function pairedCost(source, evidence) {
  const sourceText = source.join("");
  const evidenceText = evidence.join("");
  if (sourceText === evidenceText) {
    if (source.length === 1 && evidence.length === 1) return 0;
    return regroupCost;
  }
  const sr = runes(sourceText);
  const er = runes(evidenceText);
  const width = Math.max(sr.length, er.length, 1);
  const distance = editDistance(sr, er) / width;
  if (source.length === 1 && evidence.length === 1) return distance * evidenceTrust;
  const grouping = regroupCost * Math.max(0, source.length + evidence.length - 2);
  const exactWords = exactWordLCS(source, evidence);
  const unmatched = source.length + evidence.length - 2 * exactWords;
  return distance * evidenceTrust * Math.max(source.length, evidence.length) + grouping + boundaryCost * unmatched;
}
function exactWordLCS(source, evidence) {
  const rows = Array.from({ length: maxGroup + 1 }, () => new Array(maxGroup + 1).fill(0));
  for (let i = source.length - 1; i >= 0; i--) {
    for (let j = evidence.length - 1; j >= 0; j--) {
      rows[i][j] = source[i] === evidence[j] ? rows[i + 1][j + 1] + 1 : Math.max(rows[i + 1][j], rows[i][j + 1]);
    }
  }
  return rows[0][0];
}
function exactRunLength(target, parts, start) {
  if (target === "") return 0;
  let joined = "";
  for (let i = start; i < parts.length; i++) {
    joined += parts[i];
    if (joined === target) return i - start + 1;
    if (joined.length >= target.length || !target.startsWith(joined)) return 0;
  }
  return 0;
}
function editDistance(left, right) {
  let previous = new Array(right.length + 1);
  let current = new Array(right.length + 1).fill(0);
  for (let j = 0; j <= right.length; j++) previous[j] = j;
  for (let i = 1; i <= left.length; i++) {
    current[0] = i;
    for (let j = 1; j <= right.length; j++) {
      let substitute = previous[j - 1];
      if (left[i - 1] !== right[j - 1]) substitute++;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, substitute);
    }
    [previous, current] = [current, previous];
  }
  return previous[right.length];
}
function alignCharacters(source, evidence) {
  const rows = [];
  for (let i = 0; i <= source.length; i++) {
    rows.push(new Array(evidence.length + 1).fill(0));
    rows[i][0] = i;
  }
  for (let j = 0; j <= evidence.length; j++) rows[0][j] = j;
  for (let i = 1; i <= source.length; i++) {
    for (let j = 1; j <= evidence.length; j++) {
      let substitute = rows[i - 1][j - 1];
      if (source[i - 1] !== evidence[j - 1]) substitute++;
      rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, substitute);
    }
  }
  const pairs = [];
  for (let i = source.length, j = evidence.length; i > 0 || j > 0; ) {
    if (i > 0 && j > 0) {
      let substitute = rows[i - 1][j - 1];
      if (source[i - 1] !== evidence[j - 1]) substitute++;
      if (rows[i][j] === substitute) {
        pairs.push({ source: i - 1, evidence: j - 1 });
        i--;
        j--;
        continue;
      }
    }
    if (i > 0 && rows[i][j] === rows[i - 1][j] + 1) {
      i--;
      continue;
    }
    j--;
  }
  pairs.reverse();
  return pairs;
}

// ../engine/src/align/evidence.ts
var import_node_fs15 = __toESM(require("node:fs"), 1);

// ../engine/src/beat/jsondecode.ts
var sliceOf = (elem) => ({ kind: "slice", elem });
var NumberLiteral = class {
  constructor(source) {
    this.source = source;
  }
  source;
};
function goTypeName(t) {
  switch (t) {
    case "int":
      return "int";
    case "int64":
      return "int64";
    case "float":
      return "float64";
    case "string":
      return "string";
    case "bool":
      return "bool";
  }
  if (t.kind === "slice") return "[]" + goTypeName(t.elem);
  return t.goName;
}
function zeroOf(t) {
  switch (t) {
    case "int":
    case "int64":
    case "float":
      return 0;
    case "string":
      return "";
    case "bool":
      return false;
  }
  if (t.kind === "slice") return null;
  const out = {};
  for (const [json, type] of t.fields) out[json] = zeroOf(type);
  return out;
}
function kindOf(value) {
  if (value instanceof NumberLiteral) return "number";
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "bool";
  if (Array.isArray(value)) return "array";
  return "object";
}
function typeError(ctx, where, value, t) {
  if (ctx.error !== void 0) return;
  if (where.struct === void 0) {
    ctx.error = `json: cannot unmarshal ${value} into Go value of type ${goTypeName(t)}`;
    return;
  }
  ctx.error = `json: cannot unmarshal ${value} into Go struct field ${where.struct.name}.${where.path.join(".")} of type ${goTypeName(t)}`;
}
var intLiteral = /^-?(?:0|[1-9][0-9]*)$/;
var maxInt64 = 9223372036854775807n;
var minInt64 = -9223372036854775808n;
function decodeValue(value, t, ctx, where) {
  if (value === null) return zeroOf(t);
  switch (t) {
    case "int":
    case "int64":
      if (!(value instanceof NumberLiteral)) {
        typeError(ctx, where, kindOf(value), t);
        return 0;
      }
      if (!intLiteral.test(value.source) || BigInt(value.source) > maxInt64 || BigInt(value.source) < minInt64) {
        typeError(ctx, where, "number " + value.source, t);
        return 0;
      }
      return Number(value.source);
    case "float": {
      if (!(value instanceof NumberLiteral)) {
        typeError(ctx, where, kindOf(value), t);
        return 0;
      }
      const n = Number(value.source);
      if (!Number.isFinite(n)) {
        typeError(ctx, where, "number " + value.source, t);
        return 0;
      }
      return n;
    }
    case "string":
      if (typeof value !== "string") {
        typeError(ctx, where, kindOf(value), t);
        return "";
      }
      return value;
    case "bool":
      if (typeof value !== "boolean") {
        typeError(ctx, where, kindOf(value), t);
        return false;
      }
      return value;
  }
  if (t.kind === "slice") {
    if (!Array.isArray(value)) {
      typeError(ctx, where, kindOf(value), t);
      return null;
    }
    return value.map((item) => decodeValue(item, t.elem, ctx, where));
  }
  if (typeof value !== "object" || Array.isArray(value) || value instanceof NumberLiteral) {
    typeError(ctx, where, kindOf(value), t);
    return zeroOf(t);
  }
  const out = zeroOf(t);
  for (const [key, item] of Object.entries(value)) {
    const field = t.fields.find(([json]) => json === key) ?? t.fields.find(([json]) => json.toLowerCase() === key.toLowerCase());
    if (!field) {
      if (ctx.disallowUnknown && ctx.error === void 0) ctx.error = `json: unknown field ${goQuote(key)}`;
      continue;
    }
    out[field[0]] = decodeValue(item, field[1], ctx, { struct: t, path: [...where.path, field[0]] });
  }
  return out;
}
function parseLiteral(text) {
  return JSON.parse(
    text,
    (_key, value, context) => typeof value === "number" ? new NumberLiteral(context?.source ?? String(value)) : value
  );
}
function decodeText(text, t, disallowUnknown) {
  const ctx = { disallowUnknown };
  const decoded = decodeValue(parseLiteral(text), t, ctx, { path: [] });
  if (ctx.error !== void 0) throw new Error(ctx.error);
  return decoded;
}
function unmarshal(body, t) {
  const data = toBytes(body);
  const syntax = scan(data, false);
  if (syntax.error !== null) throw new Error(syntax.error);
  return decodeText(Buffer.from(data).toString("utf8"), t, false);
}
function decodeFirst(body, t, disallowUnknown) {
  const data = toBytes(body);
  const syntax = scan(data, true);
  if (syntax.error !== null) throw new Error(syntax.error);
  const value = decodeText(Buffer.from(data.subarray(0, syntax.end)).toString("utf8"), t, disallowUnknown);
  return { value, rest: data.subarray(syntax.end) };
}
function checkValid(body) {
  return scan(toBytes(body), false).error;
}
function toBytes(body) {
  return typeof body === "string" ? Buffer.from(body, "utf8") : body;
}
var isSpace = (c) => c === 32 || c === 9 || c === 10 || c === 13;
var ScanError = class extends Error {
};
var endOfInput = "unexpected end of JSON input";
function quoteChar(c) {
  if (c === 39) return "'\\''";
  if (c === 34) return `'"'`;
  const short = { 7: "\\a", 8: "\\b", 12: "\\f", 10: "\\n", 13: "\\r", 9: "\\t", 11: "\\v", 92: "\\\\" };
  if (short[c] !== void 0) return `'${short[c]}'`;
  if (c < 32 || c === 127) return `'\\x${c.toString(16).padStart(2, "0")}'`;
  if (c >= 128 && (c < 161 || c === 173)) return `'\\u${c.toString(16).padStart(4, "0")}'`;
  return `'${String.fromCharCode(c)}'`;
}
function scan(data, firstOnly) {
  let i = 0;
  const at = () => i < data.length ? data[i] : -1;
  const invalid = (context) => {
    const c = i < data.length ? data[i] : 32;
    throw new ScanError(`invalid character ${quoteChar(c)} ${context}`);
  };
  const skipSpace = () => {
    while (i < data.length && isSpace(data[i])) i++;
    if (i >= data.length) throw new ScanError(endOfInput);
  };
  const isDigit2 = (c) => c >= 48 && c <= 57;
  const isHexByte = (c) => isDigit2(c) || c >= 97 && c <= 102 || c >= 65 && c <= 70;
  const literal = (word2) => {
    i++;
    for (let k = 1; k < word2.length; k++) {
      if (i >= data.length && firstOnly) throw new ScanError(endOfInput);
      if (at() !== word2.charCodeAt(k)) invalid(`in literal ${word2} (expecting '${word2[k]}')`);
      i++;
    }
  };
  const string = () => {
    i++;
    for (; ; ) {
      if (i >= data.length) throw new ScanError(endOfInput);
      const c = data[i];
      if (c === 34) {
        i++;
        return;
      }
      if (c === 92) {
        i++;
        const e = at();
        if (e === 117) {
          i++;
          for (let k = 0; k < 4; k++) {
            if (!isHexByte(at())) invalid("in \\u hexadecimal character escape");
            i++;
          }
          continue;
        }
        if (e !== -1 && '"\\/bfnrt'.includes(String.fromCharCode(e))) {
          i++;
          continue;
        }
        invalid("in string escape code");
      }
      if (c < 32) invalid("in string literal");
      i++;
    }
  };
  const number = () => {
    if (at() === 45) {
      i++;
      if (!isDigit2(at())) invalid("in numeric literal");
    }
    if (at() === 48) {
      i++;
    } else {
      while (isDigit2(at())) i++;
    }
    if (at() === 46) {
      i++;
      if (!isDigit2(at())) invalid("after decimal point in numeric literal");
      while (isDigit2(at())) i++;
    }
    if (at() === 101 || at() === 69) {
      i++;
      if (at() === 43 || at() === 45) i++;
      if (!isDigit2(at())) invalid("in exponent of numeric literal");
      while (isDigit2(at())) i++;
    }
  };
  const value = () => {
    skipSpace();
    const c = data[i];
    if (c === 123) {
      i++;
      skipSpace();
      if (at() === 125) {
        i++;
        return;
      }
      for (; ; ) {
        if (at() !== 34) invalid("looking for beginning of object key string");
        string();
        skipSpace();
        if (at() !== 58) invalid("after object key");
        i++;
        value();
        skipSpace();
        if (at() === 44) {
          i++;
          skipSpace();
          continue;
        }
        if (at() === 125) {
          i++;
          return;
        }
        invalid("after object key:value pair");
      }
    }
    if (c === 91) {
      i++;
      skipSpace();
      if (at() === 93) {
        i++;
        return;
      }
      for (; ; ) {
        value();
        skipSpace();
        if (at() === 44) {
          i++;
          continue;
        }
        if (at() === 93) {
          i++;
          return;
        }
        invalid("after array element");
      }
    }
    if (c === 34) return string();
    if (c === 45 || isDigit2(c)) return number();
    if (c === 116) return literal("true");
    if (c === 102) return literal("false");
    if (c === 110) return literal("null");
    invalid("looking for beginning of value");
  };
  try {
    value();
    if (firstOnly) return { error: null, end: i };
    while (i < data.length && isSpace(data[i])) i++;
    if (i < data.length) invalid("after top-level value");
    return { error: null, end: i };
  } catch (err) {
    if (!(err instanceof ScanError)) throw err;
    if (firstOnly && err.message === endOfInput) {
      let k = 0;
      while (k < data.length && isSpace(data[k])) k++;
      return { error: k >= data.length ? "EOF" : "unexpected EOF", end: i };
    }
    return { error: err.message, end: i };
  }
}

// ../engine/src/align/evidence.ts
var floatLiteral = /^[+-]?(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d+)?$/;
function parseFloat64(raw) {
  const lower = raw.toLowerCase();
  if (/^[+-]?(inf|infinity)$/.test(lower)) return raw.startsWith("-") ? -Infinity : Infinity;
  if (/^[+-]?nan$/.test(lower)) return NaN;
  if (!floatLiteral.test(raw) || raw.includes("_")) return null;
  return Number(raw);
}
function parseSegmentFlag(value) {
  const at = value.lastIndexOf("@");
  if (at < 0) return { path: value, offset: 0 };
  const file = value.slice(0, at);
  const raw = value.slice(at + 1);
  const offset = parseFloat64(raw);
  if (offset === null || file === "" || offset < 0 || !Number.isFinite(offset)) {
    throw new Error(`--align ${goQuote(value)} \u4E0D\u5408\u6CD5\uFF1A\u5E94\u4E3A \u6587\u4EF6[@\u504F\u79FB\u79D2\u6570]\uFF0C\u504F\u79FB\u662F\u975E\u8D1F\u6570`);
  }
  return { path: file, offset };
}
var CanonicalShape = '[{"text":"\u5B57","start":0.12,"end":0.20}, ...]\uFF08\u79D2\uFF09';
function loadSegments(segments) {
  const items2 = [];
  segments.forEach((seg, index) => {
    for (const item of loadEvidence(seg.path)) {
      items2.push({ text: item.text, start: item.start + seg.offset, end: item.end + seg.offset, segment: index });
    }
  });
  return items2;
}
function loadEvidence(file) {
  let body;
  try {
    body = import_node_fs15.default.readFileSync(file);
  } catch (err) {
    throw new Error(`\u65E0\u6CD5\u8BFB\u53D6\u5BF9\u9F50\u7ED3\u679C\uFF1A${goPathError("open", file, err)}`, { cause: err });
  }
  const syntax = checkValid(body);
  if (syntax !== null) throw new Error(`${file} \u4E0D\u662F\u5408\u6CD5 JSON\uFF1A${syntax}`);
  const root = JSON.parse(body.toString("utf8"));
  let found;
  try {
    found = findItems(root);
  } catch (err) {
    throw new Error(`${file}\uFF1A${err.message}`, { cause: err });
  }
  if (found === null) throw new Error(`${file} \u7684\u7ED3\u6784\u8BA4\u4E0D\u51FA\uFF08${describe(root)}\uFF09\u3002\u8BF7\u5148\u8F6C\u6362\u6210 ${CanonicalShape}`);
  found.forEach((item, i) => {
    if (!Number.isFinite(item.start) || !Number.isFinite(item.end) || item.start < 0 || item.end < item.start) {
      throw new Error(`${file} \u7B2C ${i + 1} \u6761\uFF08${goQuote(item.text)}\uFF09\u7684\u8D77\u6B62\u65F6\u95F4\u4E0D\u5408\u6CD5\uFF1A${formatG(item.start)} \u2192 ${formatG(item.end)}`);
    }
    if (item.end > 6 * 3600) throw new Error(`${file} \u7B2C ${i + 1} \u6761\u7684\u7ED3\u675F\u65F6\u95F4 ${formatG(item.end)} \u79D2\u8D85\u8FC7 6 \u5C0F\u65F6\uFF0C\u50CF\u662F\u6BEB\u79D2\uFF1B\u8BF7\u8F6C\u6362\u6210 ${CanonicalShape}`);
  });
  return found;
}
function isObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function findItems(node) {
  if (Array.isArray(node)) {
    const funasr = funasrItems(node);
    if (funasr !== null) return funasr;
    const timed = timedItems(node);
    if (timed !== null) return timed;
    for (const child of node) {
      const items2 = findItems(child);
      if (items2 !== null) return items2;
    }
  } else if (isObject(node)) {
    for (const key of sortedKeys2(node)) {
      const items2 = findItems(node[key]);
      if (items2 !== null) return items2;
    }
  }
  return null;
}
var textKeys = ["text", "word", "char", "token"];
var timeKeyPairs = [
  { start: "start", end: "end", scale: 1 },
  { start: "start_time", end: "end_time", scale: 1 },
  { start: "start_ms", end: "end_ms", scale: 1e-3 }
];
function timedItems(values) {
  if (values.length === 0) return null;
  const items2 = [];
  for (const raw of values) {
    if (!isObject(raw)) return null;
    const text = textField(raw);
    if (text === null) return null;
    let matched = false;
    for (const keys of timeKeyPairs) {
      const start = raw[keys.start];
      const end = raw[keys.end];
      if (typeof start === "number" && typeof end === "number") {
        items2.push({ text, start: start * keys.scale, end: end * keys.scale, segment: 0 });
        matched = true;
        break;
      }
    }
    if (!matched) return null;
  }
  return items2;
}
function textField(object) {
  for (const key of textKeys) {
    const text = object[key];
    if (typeof text === "string") return text;
  }
  return null;
}
function fields(text) {
  const out = [];
  let current = "";
  for (const ch of text) {
    if (isSpaceChar(ch.codePointAt(0))) {
      if (current !== "") out.push(current);
      current = "";
    } else current += ch;
  }
  if (current !== "") out.push(current);
  return out;
}
function isSpaceChar(r) {
  if (r === 9 || r === 10 || r === 11 || r === 12 || r === 13 || r === 32 || r === 133 || r === 160) return true;
  return r === 5760 || r >= 8192 && r <= 8202 || r === 8232 || r === 8233 || r === 8239 || r === 8287 || r === 12288;
}
function funasrItems(values) {
  if (values.length === 0) return null;
  const items2 = [];
  for (const raw of values) {
    if (!isObject(raw)) return null;
    const text = raw.text;
    const stamps = raw.timestamp;
    if (typeof text !== "string" || !Array.isArray(stamps)) return null;
    const words = fields(text);
    if (words.length !== stamps.length) {
      throw new Error(`funasr \u7ED3\u679C\u7684 text \u6709 ${words.length} \u4E2A\u5355\u5143\uFF0Ctimestamp \u5374\u6709 ${stamps.length} \u7EC4\uFF0C\u65E0\u6CD5\u9010\u4E00\u5BF9\u5E94`);
    }
    stamps.forEach((stamp, i) => {
      if (!Array.isArray(stamp) || stamp.length !== 2) throw new Error(`funasr \u7ED3\u679C\u7B2C ${i + 1} \u4E2A timestamp \u4E0D\u662F [\u8D77, \u6B62] \u4E24\u4E2A\u6570`);
      const [start, end] = stamp;
      if (typeof start !== "number" || typeof end !== "number") throw new Error(`funasr \u7ED3\u679C\u7B2C ${i + 1} \u4E2A timestamp \u4E0D\u662F\u6570\u503C`);
      items2.push({ text: words[i], start: start / 1e3, end: end / 1e3, segment: 0 });
    });
  }
  return items2;
}
function sortedKeys2(object) {
  return Object.keys(object).sort(compareBytes);
}
function goTypeOf(value) {
  if (value === null) return "<nil>";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "float64";
  if (typeof value === "boolean") return "bool";
  if (Array.isArray(value)) return "[]interface {}";
  return "map[string]interface {}";
}
function describe(node) {
  if (isObject(node)) return "\u9876\u5C42\u662F\u5BF9\u8C61\uFF0C\u952E\uFF1A" + sortedKeys2(node).join(", ");
  if (Array.isArray(node)) {
    if (node.length === 0) return "\u9876\u5C42\u662F\u7A7A\u6570\u7EC4";
    const first = node[0];
    if (isObject(first)) return `\u9876\u5C42\u662F ${node.length} \u4E2A\u5143\u7D20\u7684\u6570\u7EC4\uFF0C\u9996\u5143\u7D20\u7684\u952E\uFF1A${sortedKeys2(first).join(", ")}`;
    return `\u9876\u5C42\u662F ${node.length} \u4E2A\u5143\u7D20\u7684\u6570\u7EC4\uFF0C\u9996\u5143\u7D20\u7C7B\u578B ${goTypeOf(first)}`;
  }
  return `\u9876\u5C42\u662F ${goTypeOf(node)}`;
}

// ../engine/src/reads/reads.ts
var Defaults = { charsPerSecond: 9, minSeconds: 5 / 6, crowdSeconds: 0.3 };
var scriptRe = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
var letterOrDigitRe = /[\p{L}\p{Nd}]/u;
function units(text) {
  let count = 0;
  let inWord = false;
  for (const r of text) {
    if (scriptRe.test(r)) {
      count++;
      inWord = false;
    } else if (letterOrDigitRe.test(r)) {
      if (!inWord) {
        count++;
      }
      inWord = true;
    } else {
      inWord = false;
    }
  }
  return count;
}

// ../engine/src/align/cue.ts
var MaxCueUnits = 32;
var containsAny = (s, chars) => s !== "" && [...s].some((c) => chars.includes(c));
var isSentenceEnd = (s) => containsAny(s, "\u3002\uFF01\uFF1F!?\uFF1B;");
var isClauseEnd = (s) => containsAny(s, "\uFF0C\u3001,");
var isCloser = (s) => containsAny(s, `\u201D\u2019\u300D\u300F\uFF09)\u3011\u300B"'`);
function sentences(s) {
  const out = [];
  let start = 0;
  let pending = false;
  s.pieces.forEach((p, i) => {
    if (i > start && p.para !== s.pieces[i - 1].para) {
      out.push([start, i]);
      start = i;
      pending = false;
    }
    if (pending && !(p.plain && isCloser(p.display))) {
      out.push([start, i]);
      start = i;
      pending = false;
    }
    if (p.plain && isSentenceEnd(p.display)) pending = true;
  });
  if (start < s.pieces.length) out.push([start, s.pieces.length]);
  return out;
}
function splitLong(s, sentence) {
  if (units(s.displayText(sentence[0], sentence[1])) <= MaxCueUnits) return [sentence];
  const clauses = [];
  let start = sentence[0];
  for (let i = sentence[0]; i < sentence[1]; i++) {
    if (s.pieces[i].plain && isClauseEnd(s.pieces[i].display)) {
      clauses.push([start, i + 1]);
      start = i + 1;
    }
  }
  if (start < sentence[1]) clauses.push([start, sentence[1]]);
  const out = [];
  let current = [...clauses[0]];
  for (const clause of clauses.slice(1)) {
    if (units(s.displayText(current[0], clause[1])) <= MaxCueUnits) {
      current[1] = clause[1];
      continue;
    }
    out.push(current);
    current = [...clause];
  }
  out.push(current);
  return out;
}
function buildCues(s, timed) {
  const ranges = [];
  for (const sentence of sentences(s)) ranges.push(...splitLong(s, sentence));
  let cues = [];
  const blank = (from, to, tok0, tok1) => ({ index: 0, startMs: 0, endMs: 0, text: "", from, to, tok0, tok1 });
  for (const r of ranges) {
    const [tok0, tok1] = s.tokenRange(r[0], r[1]);
    if (tok1 === tok0) {
      if (cues.length > 0) cues[cues.length - 1].to = r[1];
      else if (ranges.length > 1) {
        cues.push(blank(r[0], r[1], -1, 0));
      }
      continue;
    }
    if (cues.length > 0 && cues[cues.length - 1].tok0 < 0) {
      const last = cues[cues.length - 1];
      last.to = r[1];
      last.tok0 = tok0;
      last.tok1 = tok1;
      continue;
    }
    cues.push(blank(r[0], r[1], tok0, tok1));
  }
  if (cues.length > 0 && cues[cues.length - 1].tok0 < 0) cues = cues.slice(0, -1);
  for (let i = 0; i < cues.length && cues.length > 1; ) {
    if (s.displayText(cues[i].from, cues[i].to) !== "") {
      i++;
      continue;
    }
    if (i > 0) {
      cues[i - 1].to = cues[i].to;
      cues[i - 1].tok1 = cues[i].tok1;
    } else {
      cues[1].from = cues[0].from;
      cues[1].tok0 = cues[0].tok0;
    }
    cues.splice(i, 1);
  }
  let previousEnd = 0;
  cues.forEach((c, i) => {
    c.index = i + 1;
    c.text = s.displayText(c.from, c.to);
    let start = Infinity;
    let end = -Infinity;
    for (const t of timed.slice(c.tok0, c.tok1)) {
      start = Math.min(start, t.start);
      end = Math.max(end, t.end);
    }
    c.startMs = toMs(start);
    c.endMs = toMs(end);
    if (i > 0 && c.startMs < previousEnd) c.startMs = previousEnd;
    if (c.endMs <= c.startMs) c.endMs = c.startMs + 1;
    previousEnd = c.endMs;
  });
  return cues;
}
function cueOfPiece(cues, piece) {
  for (const c of cues) if (piece >= c.from && piece < c.to) return c.index;
  return 0;
}
function toMs(seconds) {
  return goRound(seconds * 1e3) + 0;
}
function formatSRT(cues) {
  let b = "";
  cues.forEach((c, i) => {
    if (i > 0) b += "\n";
    b += `${c.index}
${srtClock(c.startMs)} --> ${srtClock(c.endMs)}
${c.text}
`;
  });
  return b;
}
function writeSRT(file, cues) {
  atomicWrite(file, Buffer.from(formatSRT(cues), "utf8"), 420);
}
function pad(value, width) {
  const negative = value < 0;
  const digits = String(Math.abs(value)).padStart(negative ? width - 1 : width, "0");
  return negative ? "-" + digits : digits;
}
function srtClock(ms) {
  const h = Math.trunc(ms / 36e5);
  const m = Math.trunc(ms / 6e4) % 60;
  const sec = Math.trunc(ms / 1e3) % 60;
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(sec, 2)},${pad(ms % 1e3, 3)}`;
}

// ../engine/src/align/phrase.ts
var import_node_fs16 = __toESM(require("node:fs"), 1);

// ../engine/src/beat/store.ts
var import_yaml = __toESM(require_dist(), 1);
var Store = "production/beat";
var ConfigFile = "beat.yaml";
var TrackFile = Store + "/track.json";
var DraftFile = Store + "/grid-draft.json";
var GridFile = Store + "/grid.json";
var ClickFile = Store + "/grid-click.wav";
var PlanFile = Store + "/plan.json";
var AnalysisFile = Store + "/analysis.wav";
var AnalyzerVersion = "1.1.0";
var DefaultConfig = `schema: 1
# \u8282\u62CD\u6A21\u578B\uFF1Afinal0\uFF08\u7EA6 78 MB\uFF0C\u9ED8\u8BA4\uFF09\u6216 small0\uFF08\u7EA6 8 MB\uFF0C\u7CBE\u5EA6\u7565\u4F4E\uFF09\uFF1B
# \u540C\u7CFB\u5217\u8FD8\u6709 final1/final2\u3001small1/small2\uFF0C\u662F\u4E0D\u540C\u968F\u673A\u79CD\u5B50\u8BAD\u7EC3\u7684\u540C\u7ED3\u6784\u6A21\u578B\u3002
checkpoint: final0
# \u88C5\u6709 beat-this==${AnalyzerVersion} \u7684\u72EC\u7ACB Python \u73AF\u5883
python: python3
`;

// ../engine/src/beat/grid.ts
var gridType = {
  kind: "struct",
  goName: "beat.Grid",
  name: "Grid",
  fields: [
    ["schema", "int"],
    ["audio_sha256", "string"],
    ["duration_seconds", "float"],
    ["source", "string"],
    ["reviewed", "bool"],
    ["beats", sliceOf("float")],
    ["downbeats", sliceOf("float")]
  ]
};
function frameOf(seconds, fps) {
  return goRound(seconds * fps) + 0;
}
function totalFrames(duration, fps) {
  return Math.ceil(duration * fps - 1e-9) + 0;
}

// ../engine/src/beat/plan.ts
var plannedShotType = {
  kind: "struct",
  goName: "beat.PlannedShot",
  name: "PlannedShot",
  fields: [
    ["id", "string"],
    ["bars", "int"]
  ]
};
var planType = {
  kind: "struct",
  goName: "beat.Plan",
  name: "Plan",
  fields: [
    ["schema", "int"],
    ["scenes", sliceOf(plannedShotType)]
  ]
};

// ../engine/src/beat/analyze.ts
var analyzeScript = `import importlib.metadata as m, json, sys, wave
v = m.version('beat-this')
if v != '${AnalyzerVersion}':
    sys.exit('beat-this ' + v + ' != ${AnalyzerVersion}')
import numpy as np
from beat_this.inference import Audio2Beats
if sys.argv[1] == '--doctor':
    Audio2Beats(checkpoint_path=sys.argv[2], device='cpu', dbn=False)
    sys.exit(0)
with wave.open(sys.argv[1], 'rb') as w:
    if w.getnchannels() != 1 or w.getsampwidth() != 2:
        sys.exit('analysis wav must be mono 16-bit')
    sr = w.getframerate()
    signal = np.frombuffer(w.readframes(w.getnframes()), dtype='<i2').astype(np.float32) / 32768
beats, downbeats = Audio2Beats(checkpoint_path=sys.argv[2], device='cpu', dbn=False)(signal, sr)
with open(sys.argv[3], 'w') as f:
    json.dump({'beats': [float(b) for b in beats], 'downbeats': [float(d) for d in downbeats]}, f)
`;
var rawType = {
  kind: "struct",
  goName: 'struct { Beats []float64 "json:\\"beats\\""; Downbeats []float64 "json:\\"downbeats\\"" }',
  name: "",
  fields: [
    ["beats", sliceOf("float")],
    ["downbeats", sliceOf("float")]
  ]
};

// ../engine/src/align/phrase.ts
var SourceForced = "forced-alignment";
var SourceInterpolated = "interpolated";
var SourceAdjusted = "adjusted";
var TimelineSchema = 1;
var phraseType = {
  kind: "struct",
  goName: "align.Phrase",
  name: "Phrase",
  fields: [
    ["phrase_id", "string"],
    ["subtitle_index", "int"],
    ["source_text", "string"],
    ["semantic_order", "int"],
    ["start_ms", "int64"],
    ["end_ms", "int64"],
    ["start_frame", "int"],
    ["end_frame_exclusive", "int"],
    ["alignment_source", "string"],
    ["confidence", "float"],
    ["reviewed", "bool"],
    ["visible_event_ids", sliceOf("string")]
  ]
};
var timelineType = {
  kind: "struct",
  goName: "align.Timeline",
  name: "Timeline",
  fields: [
    ["schema", "int"],
    ["fps", "int"],
    ["phrases", sliceOf(phraseType)]
  ]
};
function timelineToJSON(t) {
  return {
    schema: t.schema,
    fps: t.fps,
    phrases: t.phrases === null ? null : t.phrases.map((p) => ({
      phrase_id: p.phrase_id,
      subtitle_index: p.subtitle_index,
      source_text: p.source_text,
      semantic_order: p.semantic_order,
      start_ms: p.start_ms,
      end_ms: p.end_ms,
      start_frame: p.start_frame,
      end_frame_exclusive: p.end_frame_exclusive,
      alignment_source: p.alignment_source,
      confidence: p.confidence,
      reviewed: p.reviewed,
      visible_event_ids: p.visible_event_ids
    }))
  };
}
function loadExistingTimeline(file) {
  let body;
  try {
    body = import_node_fs16.default.readFileSync(file);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw new Error(`\u65E0\u6CD5\u8BFB\u53D6\u5DF2\u6709\u77ED\u8BED\u65F6\u95F4\u8F74\uFF1A${goPathError("open", file, err)}`, { cause: err });
  }
  try {
    return unmarshal(body, timelineType);
  } catch (err) {
    throw new Error(
      `\u5DF2\u6709\u77ED\u8BED\u65F6\u95F4\u8F74 ${file} \u4E0D\u662F\u5408\u6CD5 JSON \u6216\u5B57\u6BB5\u7C7B\u578B\u4E0D\u7B26\uFF0C\u4E3A\u514D\u8986\u76D6\u5176\u4E2D\u624B\u586B\u7684 visible_event_ids\uFF0C\u5148\u4FEE\u597D\u6216\u79FB\u8D70\u5B83\uFF1A${err.message}`,
      { cause: err }
    );
  }
}
var adjustmentType = {
  kind: "struct",
  goName: "align.Adjustment",
  name: "Adjustment",
  fields: [
    ["phrase_id", "string"],
    ["edge", "string"],
    ["frame", "int"],
    ["reason", "string"]
  ]
};
var adjustFileType = {
  kind: "struct",
  goName: "align.AdjustFile",
  name: "AdjustFile",
  fields: [
    ["schema", "int"],
    ["adjustments", sliceOf(adjustmentType)]
  ]
};
function loadAdjust(file) {
  let body;
  try {
    body = import_node_fs16.default.readFileSync(file);
  } catch (err) {
    throw new Error(`\u65E0\u6CD5\u8BFB\u53D6\u4FEE\u6B63\u6587\u4EF6\uFF1A${goPathError("open", file, err)}`, { cause: err });
  }
  let adjust;
  try {
    adjust = decodeFirst(body, adjustFileType, true).value;
  } catch (err) {
    throw new Error(`${file} \u4E0D\u662F\u5408\u6CD5 JSON \u6216\u542B\u672A\u77E5\u5B57\u6BB5\uFF1A${err.message}`, { cause: err });
  }
  if (adjust.schema !== 1) throw new Error(`${file} \u7684 schema \u5E94\u4E3A 1\uFF0C\u6536\u5230 ${adjust.schema}`);
  return adjust;
}
function timePhrases(s, timed, cues, fps) {
  return s.phrases.map((span) => {
    const [tok0, tok1] = s.tokenRange(span.startPiece, span.endPiece);
    const p = {
      span,
      text: s.displayText(span.startPiece, span.endPiece),
      tok0,
      tok1,
      start: 0,
      end: 0,
      source: "",
      confidence: 0,
      labels: /* @__PURE__ */ new Map(),
      omitted: false,
      allInterp: false,
      subtitle: 0,
      measuredFrom: 0,
      measuredTo: 0
    };
    if (p.tok1 === p.tok0) {
      let at = 0;
      if (p.tok0 > 0) at = timed[p.tok0 - 1].end;
      else if (p.tok0 < timed.length) at = timed[p.tok0].start;
      p.start = at;
      p.end = at;
      p.source = SourceInterpolated;
      p.allInterp = true;
      p.subtitle = cueOfPiece(cues, span.startPiece);
    } else {
      const first = timed[p.tok0];
      const last = timed[p.tok1 - 1];
      p.start = first.start;
      p.end = last.end;
      p.source = SourceForced;
      if (first.interpolated || last.interpolated) p.source = SourceInterpolated;
      let score = 0;
      p.allInterp = true;
      for (const t of timed.slice(p.tok0, p.tok1)) {
        p.labels.set(t.label, (p.labels.get(t.label) ?? 0) + 1);
        switch (t.label) {
          case LabelExact:
          case LabelSplit:
          case LabelMerge:
            score++;
            break;
          case LabelReplace:
            score += 0.5;
            break;
          case LabelOmission:
            p.omitted = true;
            break;
        }
        if (!t.interpolated) p.allInterp = false;
      }
      p.confidence = round3(score / (p.tok1 - p.tok0));
      p.subtitle = cueOfPiece(cues, first.firstPiece);
    }
    [p.measuredFrom, p.measuredTo] = frames(toMs(p.start), toMs(p.end), fps);
    return p;
  });
}
function frames(startMs2, endMs, fps) {
  const start = frameOf(startMs2 / 1e3, fps);
  const end = Math.max(frameOf(endMs / 1e3, fps), start + 1);
  return [start, end];
}
function round3(v) {
  return goRound(v * 1e3) / 1e3;
}
function applyAdjustments(phrases, adjust, totalFrames2) {
  const final = /* @__PURE__ */ new Map();
  for (const p of phrases) final.set(p.span.id, [p.measuredFrom, p.measuredTo]);
  const adjusted = /* @__PURE__ */ new Set();
  if (!adjust) return { final, adjusted };
  const seen = /* @__PURE__ */ new Set();
  const problems2 = [];
  (adjust.adjustments ?? []).forEach((a, i) => {
    const where = `\u7B2C ${i + 1} \u6761\u4FEE\u6B63\uFF08${a.phrase_id} ${a.edge}\uFF09`;
    const found = final.get(a.phrase_id);
    if (!found) {
      problems2.push(where + "\uFF1A\u7EC8\u7A3F\u91CC\u6CA1\u6709\u8FD9\u4E2A\u77ED\u8BED");
      return;
    }
    if (a.edge !== "start" && a.edge !== "end") {
      problems2.push(where + "\uFF1Aedge \u53EA\u80FD\u662F start \u6216 end");
      return;
    }
    if (goTrimSpace(a.reason) === "") {
      problems2.push(where + "\uFF1Areason \u4E0D\u80FD\u4E3A\u7A7A\uFF0C\u5199\u6E05\u695A\u4E3A\u4EC0\u4E48\u4E0D\u4FE1\u5B9E\u6D4B");
      return;
    }
    if (seen.has(a.phrase_id + "\0" + a.edge)) {
      problems2.push(where + "\uFF1A\u540C\u4E00\u77ED\u8BED\u7684\u540C\u4E00\u8FB9\u754C\u91CD\u590D\u4FEE\u6B63");
      return;
    }
    seen.add(a.phrase_id + "\0" + a.edge);
    const limit = a.edge === "end" ? totalFrames2 : totalFrames2 - 1;
    if (a.frame < 0 || a.frame > limit) {
      problems2.push(`${where}\uFF1A\u5E27 ${a.frame} \u8D85\u51FA [0, ${limit}]\uFF08\u5168\u7247\u5171 ${totalFrames2} \u5E27\uFF09`);
      return;
    }
    const current = [found[0], found[1]];
    if (a.edge === "start") current[0] = a.frame;
    else current[1] = a.frame;
    final.set(a.phrase_id, current);
    adjusted.add(a.phrase_id);
  });
  for (const p of phrases) {
    const r = final.get(p.span.id);
    if (adjusted.has(p.span.id) && r[0] >= r[1]) problems2.push(`\u77ED\u8BED ${p.span.id} \u4FEE\u6B63\u540E\u8D77\u70B9\u5E27 ${r[0]} \u4E0D\u65E9\u4E8E\u7EC8\u70B9\u5E27 ${r[1]}`);
  }
  if (problems2.length > 0) throw new Error(`\u4FEE\u6B63\u6587\u4EF6\u4E0D\u5408\u683C\uFF1A
  - ${problems2.join("\n  - ")}`);
  return { final, adjusted };
}

// ../engine/src/align/timing.ts
function evidenceTokens(items2) {
  const out = [];
  for (const item of items2) {
    const tokens = tokenize2(item.text);
    let total = 0;
    for (const t of tokens) total += runes(t.norm).length;
    let consumed = 0;
    for (const t of tokens) {
      const width = runes(t.norm).length;
      const start = item.start + (item.end - item.start) * consumed / total;
      consumed += width;
      const end = item.start + (item.end - item.start) * consumed / total;
      out.push({ text: t.text, norm: t.norm, start, end, segment: item.segment });
    }
  }
  return out;
}
function locate(source, evidence, groups) {
  const timed = source.map((t) => ({ ...t, label: "", heard: "", start: 0, end: 0, interpolated: false }));
  const located = source.map(() => ({ start: 0, end: 0, ok: false }));
  for (const g of groups) {
    const heard = evidence.slice(g.e0, g.e1).map((e) => e.text);
    for (let i = g.s0; i < g.s1; i++) timed[i] = { ...source[i], label: g.label, heard: heard.join(" "), start: 0, end: 0, interpolated: false };
    if (g.s1 > g.s0 && g.e1 > g.e0) locateGroup(g, source, evidence, located);
  }
  let startBound = 0;
  let endBound = 0;
  if (evidence.length > 0) {
    startBound = evidence[0].start;
    endBound = evidence[0].end;
    for (const e of evidence) {
      startBound = Math.min(startBound, e.start);
      endBound = Math.max(endBound, e.end);
    }
  }
  fillMissing(located, source, startBound, endBound, timed);
  timed.forEach((t, i) => {
    t.start = located[i].start;
    t.end = located[i].end;
  });
  return timed;
}
function locateGroup(g, source, evidence, located) {
  const evChars = [];
  const evTimes = [];
  const win = { start: evidence[g.e0].start, end: evidence[g.e0].end, ok: true };
  for (const e of evidence.slice(g.e0, g.e1)) {
    win.start = Math.min(win.start, e.start);
    win.end = Math.max(win.end, e.end);
    const rs = runes(e.norm);
    rs.forEach((r, k) => {
      const step = (e.end - e.start) / rs.length;
      evChars.push(r);
      evTimes.push({ start: e.start + step * k, end: e.start + step * (k + 1) });
    });
  }
  if (g.s1 - g.s0 === 1) {
    located[g.s0] = win;
    return;
  }
  const srcChars = [];
  const owner = [];
  for (let i = g.s0; i < g.s1; i++) {
    for (const r of runes(source[i].norm)) {
      srcChars.push(r);
      owner.push(i);
    }
  }
  for (const p of alignCharacters(srcChars, evChars)) {
    const i = owner[p.source];
    const t = evTimes[p.evidence];
    if (!located[i].ok) located[i] = { start: t.start, end: t.end, ok: true };
    else located[i].end = Math.max(located[i].end, t.end);
  }
  if (located[g.s0].ok) located[g.s0].start = win.start;
  if (located[g.s1 - 1].ok) located[g.s1 - 1].end = win.end;
}
function fillMissing(values, source, startBound, endBound, timed) {
  for (let cursor = 0; cursor < values.length; ) {
    if (values[cursor].ok) {
      cursor++;
      continue;
    }
    const runStart = cursor;
    while (cursor < values.length && !values[cursor].ok) cursor++;
    const runEnd = cursor;
    let left = startBound;
    let right = endBound;
    if (runStart > 0) left = values[runStart - 1].end;
    if (runEnd < values.length) right = values[runEnd].start;
    right = Math.max(left, right);
    let total = 0;
    for (let i = runStart; i < runEnd; i++) total += Math.max(1, runes(source[i].norm).length);
    let consumed = 0;
    for (let i = runStart; i < runEnd; i++) {
      const start = left + (right - left) * consumed / total;
      consumed += Math.max(1, runes(source[i].norm).length);
      const end = left + (right - left) * consumed / total;
      values[i] = { start, end, ok: true };
      timed[i].interpolated = true;
    }
  }
}

// ../engine/src/align/build.ts
var MinMatchRate = 0.85;
var HintConfidence = 0.9;
var segmentSlack = 0.05;
var maxListed = 30;
var ReportSchemaVersion2 = 1;
function reportToJSON(r) {
  return {
    schema_version: r.schema_version,
    ok: r.ok,
    fps: r.fps,
    tokens: r.tokens,
    evidence_tokens: r.evidence_tokens,
    labels: sortedKeys(r.labels),
    match_rate: r.match_rate,
    interpolated_tokens: r.interpolated_tokens,
    speech_start_ms: r.speech_start_ms,
    speech_end_ms: r.speech_end_ms,
    total_frames: r.total_frames,
    cues: r.cues,
    phrases: r.phrases.map((p) => ({
      phrase_id: p.phrase_id,
      confidence: p.confidence,
      alignment_source: p.alignment_source,
      labels: sortedKeys(p.labels),
      measured_start_frame: p.measured_start_frame,
      measured_end_frame_exclusive: p.measured_end_frame_exclusive,
      start_frame: p.start_frame,
      end_frame_exclusive: p.end_frame_exclusive
    })),
    irregular: r.irregular.map((i) => ({
      label: i.label,
      script: i.script || void 0,
      heard: i.heard || void 0,
      line: i.line || void 0,
      col: i.col || void 0,
      start_ms: i.start_ms,
      end_ms: i.end_ms
    })),
    problems: r.problems,
    hints: r.hints.length > 0 ? r.hints : void 0
  };
}
function build(script, items2, opts) {
  if (opts.fps <= 0) throw new Error(`fps \u5FC5\u987B\u662F\u6B63\u6574\u6570\uFF0C\u6536\u5230 ${opts.fps}`);
  if (script.tokens.length === 0) throw new Error("\u7EC8\u7A3F\u6CA1\u6709\u4EFB\u4F55\u6717\u8BFB\u5185\u5BB9");
  const report = {
    schema_version: ReportSchemaVersion2,
    ok: false,
    fps: opts.fps,
    tokens: 0,
    evidence_tokens: 0,
    labels: {},
    match_rate: 0,
    interpolated_tokens: 0,
    speech_start_ms: 0,
    speech_end_ms: 0,
    total_frames: 0,
    cues: 0,
    phrases: [],
    irregular: [],
    problems: [],
    hints: []
  };
  items2 = items2 ?? [];
  checkSegmentOrder(items2, report);
  const evidence = evidenceTokens(items2);
  const source = script.tokens.map((t) => t.norm);
  const target = evidence.map((e) => e.norm);
  const groups = matchTokens(source, target);
  const timed = locate(script.tokens, evidence, groups);
  const cues = buildCues(script, timed);
  report.tokens = timed.length;
  report.evidence_tokens = evidence.length;
  report.cues = cues.length;
  let matched = 0;
  for (const t of timed) {
    report.labels[t.label] = (report.labels[t.label] ?? 0) + 1;
    if (t.label === LabelExact || t.label === LabelSplit || t.label === LabelMerge) matched++;
    if (t.interpolated) report.interpolated_tokens++;
  }
  report.match_rate = round3(matched / timed.length);
  describeGroups(groups, timed, evidence, report);
  if (evidence.length === 0) {
    report.problems.push("\u5BF9\u9F50\u7ED3\u679C\u91CC\u6CA1\u6709\u4EFB\u4F55\u53EF\u7528\u7684\u5B57\u6216\u8BCD\uFF1A\u786E\u8BA4\u5BF9\u9F50\u5DE5\u5177\u8DD1\u5B8C\u4E86\uFF0C\u4E14\u8F93\u5165\u662F\u5B9E\u9645\u9001\u8FDB TTS \u7684\u6587\u672C");
  } else {
    let first = evidence[0].start;
    let last = evidence[0].end;
    for (const e of evidence) {
      first = Math.min(first, e.start);
      last = Math.max(last, e.end);
    }
    report.speech_start_ms = toMs(first);
    report.speech_end_ms = toMs(last);
    if (report.speech_end_ms <= report.speech_start_ms) report.problems.push("\u5BF9\u9F50\u7ED3\u679C\u7684\u603B\u65F6\u95F4\u8DE8\u5EA6\u4E3A\u7A7A");
  }
  if (timed.length > 0) {
    let lastEnd = timed[0].end;
    for (const t of timed) lastEnd = Math.max(lastEnd, t.end);
    report.total_frames = totalFrames(toMs(lastEnd) / 1e3, opts.fps);
  }
  if (report.match_rate < MinMatchRate) {
    report.problems.push(
      `\u7CBE\u786E\u5339\u914D\u7387 ${formatFixed(report.match_rate * 100, 1)}% \u4F4E\u4E8E ${formatFixed(MinMatchRate * 100, 0)}%\uFF1A\u9001\u8FDB\u5BF9\u9F50\u7684\u6587\u672C\u53EF\u80FD\u4E0D\u662F am align text \u4EA7\u51FA\u7684\u90A3\u4EFD\uFF0C\u6216\u914D\u97F3\u4E0E\u7EC8\u7A3F\u5DEE\u5F02\u8FC7\u5927`
    );
  }
  const phrases = timePhrases(script, timed, cues, opts.fps);
  const { final, adjusted } = applyAdjustments(phrases, opts.adjust, report.total_frames);
  const timeline2 = { schema: TimelineSchema, fps: opts.fps, phrases: [] };
  const existing = /* @__PURE__ */ new Map();
  for (const p of opts.existing?.phrases ?? []) existing.set(p.phrase_id, p);
  for (const p of phrases) {
    const r = final.get(p.span.id);
    const out = {
      phrase_id: p.span.id,
      subtitle_index: p.subtitle,
      source_text: p.text,
      semantic_order: p.span.order,
      start_ms: toMs(p.start),
      end_ms: toMs(p.end),
      start_frame: r[0],
      end_frame_exclusive: r[1],
      alignment_source: p.source,
      confidence: p.confidence,
      reviewed: false,
      visible_event_ids: []
    };
    const old = existing.get(p.span.id);
    if (old) {
      out.reviewed = old.reviewed;
      if (old.visible_event_ids !== null) out.visible_event_ids = old.visible_event_ids;
    }
    if (adjusted.has(p.span.id)) {
      out.alignment_source = SourceAdjusted;
      out.reviewed = true;
      out.start_ms = frameMs(r[0], opts.fps);
      out.end_ms = frameMs(r[1], opts.fps);
    }
    timeline2.phrases.push(out);
    report.phrases.push({
      phrase_id: p.span.id,
      confidence: p.confidence,
      alignment_source: out.alignment_source,
      labels: Object.fromEntries(p.labels),
      measured_start_frame: p.measuredFrom,
      measured_end_frame_exclusive: p.measuredTo,
      start_frame: r[0],
      end_frame_exclusive: r[1]
    });
    judgePhrase(p, report);
  }
  if (opts.existing) {
    const current = new Set(phrases.map((p) => p.span.id));
    for (const old of opts.existing.phrases ?? []) {
      if (!current.has(old.phrase_id)) {
        let note = "";
        if (old.visible_event_ids !== null && old.visible_event_ids.length > 0) {
          note = `\uFF0C\u5B83\u7ED1\u5B9A\u7684\u53EF\u89C1\u4E8B\u4EF6 [${old.visible_event_ids.join(" ")}] \u9700\u8981\u6539\u7ED1`;
        }
        report.hints.push(`\u77ED\u8BED ${old.phrase_id} \u5DF2\u4E0D\u5728\u7EC8\u7A3F\u91CC\uFF0C\u5DF2\u4ECE\u65F6\u95F4\u8F74\u79FB\u9664${note}`);
      }
    }
  }
  report.ok = report.problems.length === 0;
  return { cues, timeline: timeline2, report, tokens: timed };
}
function frameMs(frame, fps) {
  return toMs(frame / fps);
}
function judgePhrase(p, report) {
  const where = `\u77ED\u8BED ${p.span.id}\u300C${p.text}\u300D\uFF08\u7EC8\u7A3F\u7B2C ${p.span.line} \u884C\uFF09`;
  if (p.tok1 === p.tok0) {
    report.problems.push(where + "\u6CA1\u6709\u6717\u8BFB\u5185\u5BB9\uFF0C\u65E0\u6CD5\u4ECE\u914D\u97F3\u5B9A\u65F6\uFF1B\u6539\u6210\u6717\u8BFB\u4FA7\u6709\u5B57\uFF0C\u6216\u53BB\u6389\u77ED\u8BED\u6807\u8BB0");
  } else if (p.omitted) {
    report.problems.push(where + "\u91CC\u6709\u5B57\u5728\u5BF9\u9F50\u7ED3\u679C\u4E2D\u627E\u4E0D\u5230\uFF1ATTS \u6F0F\u8BFB\u6216\u5BF9\u9F50\u4E22\u4E86\uFF0C\u91CD\u65B0\u5408\u6210\u6216\u68C0\u67E5\u9001\u8FDB\u5BF9\u9F50\u7684\u6587\u672C");
  } else if (p.allInterp) {
    report.problems.push(where + "\u5168\u90E8\u65F6\u95F4\u90FD\u662F\u63D2\u503C\u5F97\u6765\uFF0C\u6CA1\u6709\u4EFB\u4F55\u5B9E\u6D4B\u4F9D\u636E");
  } else if (p.confidence < HintConfidence) {
    report.hints.push(`${where}\u7F6E\u4FE1\u5EA6 ${formatFixed(p.confidence, 2)}\uFF0C\u4F4E\u4E8E ${formatFixed(HintConfidence, 2)}\uFF0C\u590D\u6838\u5B83\u7684\u8D77\u6B62\u5E27`);
  }
}
function describeGroups(groups, timed, evidence, report) {
  const insertions = [];
  const replacements = [];
  for (const g of groups) {
    if (g.label === LabelExact) continue;
    const item = { label: g.label, script: "", heard: "", line: 0, col: 0, start_ms: 0, end_ms: 0 };
    item.script = timed.slice(g.s0, g.s1).map((t) => t.text).join("");
    item.heard = evidence.slice(g.e0, g.e1).map((e) => e.text).join(" ");
    if (g.s1 > g.s0) {
      item.line = timed[g.s0].line;
      item.col = timed[g.s0].col;
      item.start_ms = toMs(timed[g.s0].start);
      item.end_ms = toMs(timed[g.s1 - 1].end);
    } else if (g.e1 > g.e0) {
      item.start_ms = toMs(evidence[g.e0].start);
      item.end_ms = toMs(evidence[g.e1 - 1].end);
    }
    report.irregular.push(item);
    const at = `${formatFixed(item.start_ms / 1e3, 2)} \u79D2`;
    if (g.label === LabelInsertion) {
      report.labels[LabelInsertion] = (report.labels[LabelInsertion] ?? 0) + (g.e1 - g.e0);
      insertions.push(`\u914D\u97F3\u91CC\u591A\u51FA\u300C${item.heard}\u300D\uFF08${at}\uFF09\uFF0C\u7EC8\u7A3F\u6CA1\u6709`);
    } else if (g.label === LabelReplace) {
      replacements.push(`\u7EC8\u7A3F\u300C${item.script}\u300D\uFF08\u7B2C ${item.line} \u884C\u7B2C ${item.col} \u5217\uFF09\u5BF9\u4E0A\u7684\u662F\u300C${item.heard}\u300D\uFF08${at}\uFF09`);
    }
  }
  report.hints.push(...capList(insertions, "\u5904\u591A\u8BFB"));
  report.hints.push(...capList(replacements, "\u5904\u8BFB\u6CD5\u4E0D\u540C"));
}
function capList(items2, kind) {
  if (items2.length <= maxListed) return items2;
  return [...items2.slice(0, maxListed), `\u53E6\u6709 ${items2.length - maxListed} ${kind}\uFF0C\u89C1\u62A5\u544A irregular`];
}
function checkSegmentOrder(items2, report) {
  const segs = [];
  for (const item of items2) {
    while (segs.length <= item.segment) segs.push({ first: 0, last: 0, seen: false });
    const b = segs[item.segment];
    if (!b.seen) {
      b.first = item.start;
      b.last = item.end;
      b.seen = true;
    }
    b.first = Math.min(b.first, item.start);
    b.last = Math.max(b.last, item.end);
  }
  for (let i = 1; i < segs.length; i++) {
    if (segs[i].seen && segs[i - 1].seen && segs[i].first < segs[i - 1].last - segmentSlack) {
      report.problems.push(
        `\u7B2C ${i + 1} \u6BB5\u5BF9\u9F50\u7ED3\u679C\u5E73\u79FB\u540E\u8D77\u70B9 ${formatFixed(segs[i].first, 3)} \u79D2\u65E9\u4E8E\u7B2C ${i} \u6BB5\u7EC8\u70B9 ${formatFixed(segs[i - 1].last, 3)} \u79D2\uFF1A--align \u7684\u504F\u79FB\u5199\u9519\u4E86\uFF0C\u504F\u79FB\u5E94\u662F\u8BE5\u6BB5\u97F3\u9891\u5728\u6574\u6761\u914D\u97F3\u91CC\u7684\u8D77\u70B9`
      );
    }
  }
}
function writeJSON3(file, value) {
  atomicWrite(file, Buffer.from(marshalIndent(value) + "\n", "utf8"), 420);
}
function sortedLabels(r) {
  return Object.keys(r.labels).sort(compareBytes);
}

// src/align.ts
function newAlignCommand(stdout) {
  const root = ref(".");
  const cmd = new Command({
    use: "align",
    short: "\u7531\u4EE3\u7801\u628A\u5F3A\u5236\u5BF9\u9F50\u7ED3\u679C\u6620\u5C04\u56DE\u7EC8\u7A3F\uFF0C\u4EA7\u51FA\u5B57\u5E55\u4E0E\u77ED\u8BED\u65F6\u95F4\u8F74",
    long: `\u5BF9\u9F50\u5DE5\u5177\u53EA\u8BA4\u9001\u8FDB TTS \u7684\u6587\u672C\uFF08\u5E74\u4EFD\u5199\u6210\u9010\u4F4D\u6C49\u5B57\u3001\u7F29\u5199\u62C6\u6210\u5B57\u6BCD\uFF09\uFF0C\u8F93\u51FA\u7684\u53C8\u662F
\u4E22\u4E86\u6807\u70B9\u7684\u9010\u5B57\u65F6\u95F4\u3002\u628A\u5B83\u5BF9\u56DE\u7EC8\u7A3F\u539F\u6587\u3001\u518D\u5207\u5B57\u5E55\u3001\u7ED9\u6BCF\u4E2A\u53D7\u4FDD\u62A4\u77ED\u8BED\u7B97\u5E27\u53F7\uFF0C
\u51E0\u5343\u4E2A\u5B57\u9760\u4EBA\u773C\u505A\u4E0D\u53EF\u9760\uFF1A\u9519\u4E00\u4E2A\u5B57\u540E\u9762\u6574\u4E32\u9519\u4F4D\uFF0C\u800C\u4E14\u9519\u5F97\u6084\u65E0\u58F0\u606F\u3002\u8FD9\u7EC4\u547D\u4EE4
\u628A\u8FD9\u4E00\u6B65\u4EA4\u7ED9\u4EE3\u7801\u3002

\u6D41\u7A0B\uFF1A
  am align text                 \u4ECE\u7EC8\u7A3F\u5BFC\u51FA\u6717\u8BFB\u6587\u672C tts-text.txt\uFF0C\u9001 TTS \u4E0E\u5BF9\u9F50\u5DE5\u5177
  \uFF08\u8DD1 TTS \u4E0E\u5F3A\u5236\u5BF9\u9F50\uFF0C\u7ED3\u679C\u5B58\u4E3A production/audio/align.json\uFF09
  am align build --fps 30       \u6620\u5C04\u56DE\u7EC8\u7A3F\uFF0C\u5199\u51FA voice.srt\u3001phrase-timeline.json \u4E0E\u62A5\u544A

\u7EC8\u7A3F production/script-final.md \u7684\u6807\u8BB0\uFF1A
  <\u663E\u793A|\u6717\u8BFB>       \u663E\u793A\u4E0E\u6717\u8BFB\u4E0D\u540C\uFF1A<2024\u5E74|\u4E8C\u96F6\u4E8C\u56DB\u5E74>\u3001<API|A P I>
  <|\u55EF>             \u53EA\u6717\u8BFB\u3001\u4E0D\u663E\u793A
  <\u663E\u793A|>           \u53EA\u663E\u793A\u3001\u4E0D\u6717\u8BFB\uFF08\u6CA1\u6709\u81EA\u5DF1\u7684\u65F6\u95F4\uFF0C\u968F\u6240\u5728\u5B57\u5E55\uFF09
  @{id}\u2026@{/id}      \u53D7\u4FDD\u62A4\u77ED\u8BED\uFF0C\u5199\u8FDB phrase-timeline.json\uFF1Bid \u7528\u5C0F\u5199\u5B57\u6BCD\u3001\u6570\u5B57\u3001_\u3001-\uFF0C
                    \u53EF\u4EE5\u5D4C\u5957\uFF0C\u4E0D\u80FD\u4EA4\u53C9
  # \u5F00\u5934\u7684\u884C        \u6807\u9898\uFF0C\u5FFD\u7565
  \u7A7A\u884C              \u5206\u6BB5
  \\< \\> \\@ \\| \\\\    \u8F6C\u4E49`
  });
  cmd.persistentFlags().stringVar(root, "project-root", ".", "\u9879\u76EE\u6839\u76EE\u5F55\uFF0C\u7528\u4E8E\u5B9A\u4F4D production/ \u4E0B\u7684\u9ED8\u8BA4\u6587\u4EF6");
  const inProject = (value, fallback) => value !== "" ? value : import_node_path13.default.join(root.value, fallback);
  const textScript = ref("");
  const textOut = ref("");
  const text = new Command({
    use: "text",
    args: noArgs,
    short: "\u4ECE\u7EC8\u7A3F\u5BFC\u51FA\u9001\u8FDB TTS \u4E0E\u5BF9\u9F50\u5DE5\u5177\u7684\u6717\u8BFB\u6587\u672C",
    long: `\u89E3\u6790\u7EC8\u7A3F\u6807\u8BB0\uFF0C\u53D6\u6717\u8BFB\u4FA7\u6587\u672C\uFF1A<\u663E\u793A|\u6717\u8BFB> \u53D6\u6717\u8BFB\uFF0C# \u5F00\u5934\u7684\u884C\u4E22\u6389\uFF0C\u6BB5\u4E0E\u6BB5\u4E4B\u95F4\u6362\u884C\uFF0C
\u6807\u70B9\u4FDD\u7559\uFF08TTS \u9760\u5B83\u65AD\u53E5\uFF09\u3002TTS \u4E0E\u5F3A\u5236\u5BF9\u9F50\u90FD\u5FC5\u987B\u7528\u8FD9\u4EFD\u6587\u672C\uFF0Cam align build \u624D\u80FD
\u9010\u5B57\u5BF9\u56DE\u7EC8\u7A3F\u3002\u6807\u8BB0\u5199\u9519\u65F6\u62A5\u51FA\u884C\u53F7\u4E0E\u5217\u53F7\u3002`,
    example: `  am align text
  am align text --script production/script-final.md --out production/audio/tts-text.txt`,
    runE: () => {
      const script = loadScript(inProject(textScript.value, "production/script-final.md"));
      const spoken = script.spokenText();
      if (spoken === "") throw new Error("\u7EC8\u7A3F\u6CA1\u6709\u4EFB\u4F55\u6717\u8BFB\u5185\u5BB9");
      const out = inProject(textOut.value, "production/audio/tts-text.txt");
      atomicWrite(out, spoken, 420);
      stdout.write(`\u5DF2\u5199\u51FA\u6717\u8BFB\u6587\u672C\uFF1A${out}\uFF08${script.tokens.length} \u4E2A\u6717\u8BFB\u5355\u5143\uFF0C${script.phrases.length} \u4E2A\u53D7\u4FDD\u62A4\u77ED\u8BED\uFF09
`);
    }
  });
  text.flags().stringVar(textScript, "script", "", "\u7EC8\u7A3F\uFF0C\u7F3A\u7701\u4E3A <project-root>/production/script-final.md");
  text.flags().stringVar(textOut, "out", "", "\u6717\u8BFB\u6587\u672C\u8F93\u51FA\uFF0C\u7F3A\u7701\u4E3A <project-root>/production/audio/tts-text.txt");
  cmd.addCommand(text);
  const buildScript = ref("");
  const adjustPath = ref("");
  const srtOut = ref("");
  const phrasesOut = ref("");
  const reportOut = ref("");
  const alignFlags = ref([]);
  const fps = ref(0);
  const build2 = new Command({
    use: "build",
    args: noArgs,
    short: "\u628A\u5BF9\u9F50\u7ED3\u679C\u6620\u5C04\u56DE\u7EC8\u7A3F\uFF0C\u5199\u51FA voice.srt \u4E0E phrase-timeline.json",
    long: `\u7528\u52A8\u6001\u89C4\u5212\u628A\u7EC8\u7A3F\u6717\u8BFB\u5355\u5143\u4E0E\u5BF9\u9F50\u7ED3\u679C\u9010\u4E2A\u914D\u5BF9\uFF08\u4E00\u4E2A\u6C49\u5B57\u3001\u4E00\u4E2A\u82F1\u6587\u8BCD\u6216\u4E00\u4E2A\u6570\u662F\u4E00\u4E2A
\u5355\u5143\uFF09\uFF0C\u914D\u5BF9\u5206\u7EC4\u6700\u591A 4 \u5BF9 4\uFF0C\u6BCF\u4E2A\u5355\u5143\u5E26\u4E00\u4E2A\u6807\u7B7E\uFF1A
  exact               \u4E00\u5BF9\u4E00\uFF0C\u6587\u672C\u76F8\u540C
  split / merge       \u5206\u6BB5\u4E0D\u540C\u4F46\u62FC\u8D77\u6765\u6587\u672C\u76F8\u540C\uFF08\u4F8B\u5982 API \u88AB\u5BF9\u6210 A\u3001P\u3001I\uFF09
  replacement         \u6587\u672C\u4E0D\u540C\uFF08\u8BFB\u9519\u3001\u591A\u97F3\u5B57\u3001\u5BF9\u9F50\u5DE5\u5177\u8BA4\u9519\uFF09
  source-omission     \u7EC8\u7A3F\u6709\u3001\u914D\u97F3\u91CC\u627E\u4E0D\u5230\uFF08TTS \u6F0F\u8BFB\u6216\u5BF9\u9F50\u4E22\u4E86\uFF09\uFF0C\u65F6\u95F4\u6309\u524D\u540E\u63D2\u503C
  evidence-insertion  \u914D\u97F3\u91CC\u6709\u3001\u7EC8\u7A3F\u6CA1\u6709\uFF08\u591A\u8BFB\uFF09

\u5BF9\u9F50\u7ED3\u679C\uFF08--align\uFF0C\u53EF\u91CD\u590D\uFF09\uFF1A
  \u683C\u5F0F\u6CA1\u6709\u9010\u4E00\u5B9E\u6D4B\uFF0C\u8BFB\u53D6\u662F\u5BBD\u5BB9\u7684\u3002\u8BA4\u5F97\u7684\u5F62\u72B6\uFF1A
    \u89C4\u8303\u5F62\u72B6  ` + CanonicalShape + `
    funasr    [{"text":"\u7A7A\u683C \u5206\u9694 \u7684 \u5B57","timestamp":[[\u8D77\u6BEB\u79D2,\u6B62\u6BEB\u79D2],...]}]
    \u5176\u4ED6      JSON \u4E2D\u7B2C\u4E00\u4E2A\u300C\u6BCF\u4E2A\u5143\u7D20\u90FD\u6709 text/word/char/token \u4E0E\u6570\u503C\u8D77\u6B62\u300D\u7684\u5BF9\u8C61\u6570\u7EC4\uFF0C
              \u8D77\u6B62\u5B57\u6BB5 start/end\u3001start_time/end_time \u6309\u79D2\uFF0Cstart_ms/end_ms \u6309\u6BEB\u79D2
  \u8BA4\u4E0D\u51FA\u65F6\u62A5\u51FA\u9876\u5C42\u7ED3\u6784\uFF0C\u8BF7\u8F6C\u6362\u6210\u89C4\u8303\u5F62\u72B6\u3002
  \u5206\u6BB5\u5BF9\u9F50\u65F6\u5199 \u6587\u4EF6@\u504F\u79FB\u79D2\u6570\uFF0C\u504F\u79FB\u662F\u8BE5\u6BB5\u5728\u6574\u6761\u914D\u97F3\u91CC\u7684\u8D77\u70B9\uFF0C\u5404\u6BB5\u6309\u7ED9\u51FA\u987A\u5E8F\u9996\u5C3E\u76F8\u63A5\u3002

\u4EA7\u7269\uFF1A
  voice.srt             \u663E\u793A\u6587\u672C\u7684\u53E5\u7EA7\u5B57\u5E55\uFF0C\u6309 \u3002\uFF01\uFF1F!?\uFF1B; \u4E0E\u5206\u6BB5\u65AD\u53E5\uFF0C\u8D85\u8FC7 32 \u4E2A\u9605\u8BFB\u5355\u4F4D
                        \u518D\u5728 \uFF0C\u3001, \u5904\u5207\uFF1B\u8D77\u6B62\u53D6\u5176\u4E2D\u6717\u8BFB\u5355\u5143\u7684\u8D77\u6B62\uFF0C\u6BEB\u79D2\u7CBE\u5EA6\uFF0C\u4E92\u4E0D\u91CD\u53E0
  phrase-timeline.json  {"schema":1,"fps":30,"phrases":[{"phrase_id","subtitle_index",
                        "source_text","semantic_order","start_ms","end_ms","start_frame",
                        "end_frame_exclusive","alignment_source","confidence","reviewed",
                        "visible_event_ids"}]}
                        \u5E27\u53F7\u7528\u4E0E\u5361\u70B9\u540C\u4E00\u4E2A\u6362\u7B97\uFF08\u79D2 \xD7 fps \u56DB\u820D\u4E94\u5165\uFF09\uFF0C\u7EC8\u70B9\u81F3\u5C11\u6BD4\u8D77\u70B9\u591A\u4E00\u5E27\u3002
                        \u5DF2\u6709\u6587\u4EF6\u91CC\u7684 visible_event_ids \u4E0E reviewed \u6309 phrase_id \u4FDD\u7559\uFF1B
                        \u7EC8\u7A3F\u91CC\u5DF2\u5220\u6389\u7684\u77ED\u8BED\u79FB\u9664\u5E76\u5217\u8FDB\u63D0\u793A\u3002
  align-report.json     \u6807\u7B7E\u7EDF\u8BA1\u3001\u5339\u914D\u7387\u3001\u9010\u77ED\u8BED\u7F6E\u4FE1\u5EA6\u3001\u5168\u90E8\u975E\u7CBE\u786E\u5339\u914D\u7684\u4F4D\u7F6E\uFF0C\u4EE5\u53CA
                        problems / hints

\u4FEE\u6B63\u5C42\uFF08--adjust\uFF0C\u7F3A\u7701\u8BFB production/phrase-adjust.json\uFF0C\u4E0D\u5B58\u5728\u5219\u8DF3\u8FC7\uFF09\uFF1A
  {"schema":1,"adjustments":[{"phrase_id","edge":"start"|"end","frame":N,"reason":"\u2026"}]}
  \u5B9E\u6D4B\u786E\u5B9E\u4E0D\u5BF9\u65F6\u7528\u5B83\u6539\u77ED\u8BED\u8FB9\u754C\uFF0C\u4E0D\u8981\u624B\u6539 phrase-timeline.json\u2014\u2014\u4E0B\u6B21\u6784\u5EFA\u4F1A\u88AB\u8986\u76D6\u3002
  \u672A\u77E5\u77ED\u8BED\u3001\u540C\u4E00\u8FB9\u754C\u91CD\u590D\u3001\u5E27\u53F7\u8D8A\u754C\u3001\u6539\u5B8C\u8D77\u70B9\u4E0D\u65E9\u4E8E\u7EC8\u70B9\u3001reason \u4E3A\u7A7A\u90FD\u76F4\u63A5\u62A5\u9519\u3002
  \u88AB\u4FEE\u6B63\u7684\u77ED\u8BED alignment_source \u4E3A adjusted\uFF0Creviewed \u4E3A true\u3002

\u5224\u4E3A\u95EE\u9898\uFF08\u4ECD\u5199\u51FA\u5168\u90E8\u4EA7\u7269\uFF0C\u9000\u51FA\u7801 1\uFF09\uFF1A
  - \u53D7\u4FDD\u62A4\u77ED\u8BED\u91CC\u6709\u5B57\u88AB\u5224\u4E3A source-omission\uFF0C\u6216\u6574\u4E2A\u77ED\u8BED\u7684\u65F6\u95F4\u90FD\u662F\u63D2\u503C
  - exact + split + merge \u5360\u5168\u90E8\u6717\u8BFB\u5355\u5143\u4E0D\u5230 85%\uFF08\u9001\u8FDB\u5BF9\u9F50\u7684\u6587\u672C\u591A\u534A\u4E0D\u662F am align text \u90A3\u4EFD\uFF09
  - \u5BF9\u9F50\u7ED3\u679C\u4E3A\u7A7A\uFF0C\u6216\u591A\u6BB5\u5E73\u79FB\u540E\u524D\u540E\u91CD\u53E0\uFF08\u504F\u79FB\u5199\u9519\uFF09
\u53EA\u8FDB hints\uFF1A\u591A\u8BFB\u3001\u8BFB\u6CD5\u4E0D\u540C\u3001\u7F6E\u4FE1\u5EA6\u4F4E\u4E8E 0.9 \u7684\u77ED\u8BED\u3002`,
    example: `  am align build --fps 30

  # \u957F\u914D\u97F3\u5206\u6BB5\u5BF9\u9F50\uFF0C\u7B2C\u4E8C\u6BB5\u4ECE 312.48 \u79D2\u5F00\u59CB
  am align build --fps 30 \\
    --align production/audio/align-01.json \\
    --align production/audio/align-02.json@312.48`,
    runE: () => {
      if (fps.value <= 0) throw new Error("--fps \u5FC5\u987B\u662F\u6B63\u6574\u6570\uFF0C\u4E0E frame.md \u7684 canvas.fps \u4E00\u81F4");
      const script = loadScript(inProject(buildScript.value, "production/script-final.md"));
      const flags2 = alignFlags.value.length ? alignFlags.value : [import_node_path13.default.join(root.value, "production/audio/align.json")];
      const items2 = loadSegments(flags2.map((value) => parseSegmentFlag(value)));
      const opts = { fps: fps.value };
      const explicitAdjust = adjustPath.value !== "";
      const adjust = inProject(adjustPath.value, "production/phrase-adjust.json");
      if (import_node_fs17.default.existsSync(adjust) || explicitAdjust) opts.adjust = loadAdjust(adjust);
      const phrases = inProject(phrasesOut.value, "production/phrase-timeline.json");
      opts.existing = loadExistingTimeline(phrases);
      const result = build(script, items2, opts);
      const srt = inProject(srtOut.value, "production/audio/voice.srt");
      const report = inProject(reportOut.value, "production/audio/align-report.json");
      writeSRT(srt, result.cues);
      writeJSON3(phrases, timelineToJSON(result.timeline));
      writeJSON3(report, reportToJSON(result.report));
      const r = result.report;
      const labels = sortedLabels(r).map((label) => `${label} ${r.labels[label]}`);
      stdout.write(`\u5DF2\u5199\u51FA ${srt}\uFF08${result.cues.length} \u6761\u5B57\u5E55\uFF09\u3001${phrases}\uFF08${result.timeline.phrases?.length ?? 0} \u4E2A\u77ED\u8BED\uFF09\u3001${report}
`);
      stdout.write(`\u6717\u8BFB\u5355\u5143 ${r.tokens} \u4E2A\uFF0C\u5339\u914D\u7387 ${formatFixed(r.match_rate * 100, 1)}%\uFF08${labels.join("\uFF0C")}\uFF09\uFF0C\u5171 ${r.total_frames} \u5E27
`);
      for (const hint of r.hints ?? []) stdout.write(`\u63D0\u793A\uFF1A${hint}
`);
      if (!r.ok) throw new ExitError2(1, `\u5BF9\u9F50\u6620\u5C04\u672A\u901A\u8FC7\uFF08\u4EA7\u7269\u5DF2\u5199\u51FA\uFF0C\u8BE6\u89C1 ${report}\uFF09\uFF1A
  - ${(r.problems ?? []).join("\n  - ")}`);
    }
  });
  const flags = build2.flags();
  flags.stringVar(buildScript, "script", "", "\u7EC8\u7A3F\uFF0C\u7F3A\u7701\u4E3A <project-root>/production/script-final.md");
  flags.stringArrayVar(alignFlags, "align", [], "\u5BF9\u9F50\u7ED3\u679C \u6587\u4EF6[@\u504F\u79FB\u79D2\u6570]\uFF0C\u53EF\u91CD\u590D\uFF0C\u6309\u987A\u5E8F\u62FC\u63A5\uFF1B\u7F3A\u7701\u4E3A <project-root>/production/audio/align.json");
  flags.intVar(fps, "fps", 0, "\u5E27\u7387\uFF0C\u5FC5\u987B\u4E0E frame.md \u7684 canvas.fps \u4E00\u81F4");
  flags.stringVar(adjustPath, "adjust", "", "\u77ED\u8BED\u8FB9\u754C\u4FEE\u6B63\u5C42\uFF0C\u7F3A\u7701\u4E3A <project-root>/production/phrase-adjust.json\uFF08\u4E0D\u5B58\u5728\u5219\u8DF3\u8FC7\uFF09");
  flags.stringVar(srtOut, "srt-out", "", "\u5B57\u5E55\u8F93\u51FA\uFF0C\u7F3A\u7701\u4E3A <project-root>/production/audio/voice.srt");
  flags.stringVar(phrasesOut, "phrases-out", "", "\u77ED\u8BED\u65F6\u95F4\u8F74\u8F93\u51FA\uFF0C\u7F3A\u7701\u4E3A <project-root>/production/phrase-timeline.json");
  flags.stringVar(reportOut, "report-json", "", "\u62A5\u544A\u8F93\u51FA\uFF0C\u7F3A\u7701\u4E3A <project-root>/production/audio/align-report.json");
  cmd.addCommand(build2);
  return cmd;
}

// ../engine/src/mediaprobe/mediaprobe.ts
function videoFPS(v) {
  if (v.fps_den === 0) return 0;
  return v.fps_num / v.fps_den;
}
function videoResolution(v) {
  return `${v.width_px}x${v.height_px}`;
}
var AudioIgnore = 0;
var AudioAbsent = 1;
var AudioPresent = 2;
function validateSpec(s) {
  const duration = s.durationSeconds ?? 0;
  const tolerance = s.tolerance ?? 0;
  if (duration !== 0) {
    if (!Number.isFinite(tolerance) || tolerance < 0) throw new Error("\u65F6\u957F\u5BB9\u5DEE\u5FC5\u987B\u662F\u6709\u9650\u4E14\u975E\u8D1F\u7684\u6570\u5B57");
    if (!Number.isFinite(duration) || duration < 0) throw new Error("\u671F\u671B\u65F6\u957F\u5FC5\u987B\u662F\u6709\u9650\u4E14\u975E\u8D1F\u7684\u6570\u5B57");
  }
}
var fpsTolerance = 0.02;
function formatFPS(value) {
  if (value === Math.trunc(value)) return String(Math.trunc(value));
  return formatFixed(value, 3);
}
function orUnknown(value) {
  return value === "" ? "\u672A\u77E5" : value;
}
function checkSpec(s, m) {
  const problems2 = [];
  const v = m.video;
  if (!v) return ["\u6587\u4EF6\u6CA1\u6709\u89C6\u9891\u6D41"];
  const widthPx = s.widthPx ?? 0;
  const heightPx = s.heightPx ?? 0;
  const fps = s.fps ?? 0;
  const duration = s.durationSeconds ?? 0;
  const tolerance = s.tolerance ?? 0;
  const frames3 = s.frames ?? 0;
  if (widthPx > 0 && heightPx > 0 && (v.width_px !== widthPx || v.height_px !== heightPx)) {
    problems2.push(`\u5206\u8FA8\u7387\u4E0D\u7B26\uFF1A\u671F\u671B ${widthPx}x${heightPx}\uFF0C\u5B9E\u6D4B ${videoResolution(v)}`);
  }
  if (fps > 0 && Math.abs(videoFPS(v) - fps) > fpsTolerance) {
    problems2.push(`\u5E27\u7387\u4E0D\u7B26\uFF1A\u671F\u671B ${fps}\uFF0C\u5B9E\u6D4B ${formatFPS(videoFPS(v))}`);
  }
  if (s.codec && !equalFold(v.codec, s.codec)) {
    problems2.push(`\u89C6\u9891\u7F16\u7801\u4E0D\u7B26\uFF1A\u671F\u671B ${s.codec}\uFF0C\u5B9E\u6D4B ${orUnknown(v.codec)}`);
  }
  if (s.pixelFormat && !equalFold(v.pixel_format, s.pixelFormat)) {
    problems2.push(`\u50CF\u7D20\u683C\u5F0F\u4E0D\u7B26\uFF1A\u671F\u671B ${s.pixelFormat}\uFF0C\u5B9E\u6D4B ${orUnknown(v.pixel_format)}`);
  }
  if (duration > 0 && Math.abs(m.duration_seconds - duration) > tolerance) {
    problems2.push(
      `\u65F6\u957F\u4E0D\u7B26\uFF1A\u671F\u671B ${formatFixed(duration, 3)} \u79D2\uFF08\u5BB9\u5DEE ${formatFixed(tolerance, 3)}\uFF09\uFF0C\u5B9E\u6D4B ${formatFixed(m.duration_seconds, 3)} \u79D2`
    );
  }
  if (frames3 > 0 && v.nb_frames > 0 && v.nb_frames !== frames3) {
    problems2.push(`\u603B\u5E27\u6570\u4E0D\u7B26\uFF1A\u671F\u671B ${frames3}\uFF0C\u5B9E\u6D4B ${v.nb_frames}`);
  }
  switch (s.audio ?? AudioIgnore) {
    case AudioAbsent:
      if (m.audio) problems2.push(`\u5E94\u5F53\u6CA1\u6709\u97F3\u8F68\uFF0C\u5B9E\u6D4B\u5B58\u5728 ${orUnknown(m.audio.codec)} \u97F3\u8F68`);
      break;
    case AudioPresent:
      if (!m.audio) problems2.push("\u5E94\u5F53\u6709\u97F3\u8F68\uFF0C\u5B9E\u6D4B\u6CA1\u6709\u97F3\u8F68");
      break;
  }
  if (m.audio) {
    const sampleRate = s.sampleRate ?? 0;
    const channels = s.channels ?? 0;
    if (sampleRate > 0 && m.audio.sample_rate !== sampleRate) {
      problems2.push(`\u97F3\u9891\u91C7\u6837\u7387\u4E0D\u7B26\uFF1A\u671F\u671B ${sampleRate}\uFF0C\u5B9E\u6D4B ${m.audio.sample_rate}`);
    }
    if (channels > 0 && m.audio.channels !== channels) {
      problems2.push(`\u97F3\u9891\u58F0\u9053\u6570\u4E0D\u7B26\uFF1A\u671F\u671B ${channels}\uFF0C\u5B9E\u6D4B ${m.audio.channels}`);
    }
  }
  return problems2;
}
function equalFold(a, b) {
  return a.toLowerCase() === b.toLowerCase();
}
var flatStdDev = 2;
var darkMean = 16;
function isFlat(f) {
  return f.stddev < flatStdDev;
}
function isDark(f) {
  return f.mean < darkMean;
}
function isBlank(f) {
  return isFlat(f);
}
var ReportSchemaVersion3 = 1;
function regionFilter(r) {
  if (!r) return "";
  return `crop=${r.w}:${r.h}:${r.x}:${r.y}`;
}
function joinFilters(...filters) {
  return filters.filter((f) => f !== "").join(",");
}
function formatSeconds(value) {
  return formatFixed(value, 6);
}
function meanAbsoluteDifference(first, second) {
  if (first.length !== second.length || first.length === 0) {
    throw new Error(`\u4E24\u5E27\u50CF\u7D20\u957F\u5EA6\u4E0D\u540C\uFF08${first.length} \u4E0E ${second.length}\uFF09\uFF0C\u65E0\u6CD5\u6BD4\u5BF9`);
  }
  let sum = 0;
  for (let i = 0; i < first.length; i++) sum += Math.abs(first[i] - second[i]);
  return sum / first.length;
}
var str = (value) => typeof value === "string" ? value : "";
var int = (value) => typeof value === "number" ? Math.trunc(value) : 0;
function parse2(body, file) {
  let raw;
  try {
    raw = JSON.parse(body);
  } catch (err) {
    throw new Error(`ffprobe \u8F93\u51FA\u4E0D\u662F\u5408\u6CD5 JSON\uFF1A${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  const media = { path: file, duration_seconds: parseFloatField(str(raw?.format?.duration)), video: null, audio: null };
  for (const stream of raw?.streams ?? []) {
    switch (stream.codec_type) {
      case "video": {
        if (media.video) continue;
        let rate = str(stream.r_frame_rate);
        if (parseRational(rate) === 0) rate = str(stream.avg_frame_rate);
        const [num, den] = splitRational(rate);
        let frames3 = parseIntField(str(stream.nb_frames));
        if (frames3 === 0) frames3 = parseIntField(str(stream.nb_read_frames));
        media.video = {
          codec: str(stream.codec_name),
          width_px: int(stream.width),
          height_px: int(stream.height),
          pixel_format: str(stream.pix_fmt),
          fps_num: num,
          fps_den: den,
          nb_frames: frames3,
          color_space: str(stream.color_space),
          color_primaries: str(stream.color_primaries),
          color_transfer: str(stream.color_transfer),
          duration_seconds: parseFloatField(str(stream.duration))
        };
        break;
      }
      case "audio":
        if (media.audio) continue;
        media.audio = {
          codec: str(stream.codec_name),
          sample_rate: parseIntField(str(stream.sample_rate)),
          channels: int(stream.channels),
          duration_seconds: parseFloatField(str(stream.duration))
        };
        break;
    }
  }
  if (!media.video && !media.audio) throw new Error(`${file} \u6CA1\u6709\u53EF\u8BC6\u522B\u7684\u97F3\u89C6\u9891\u6D41`);
  return media;
}
var decimalFloat = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
function parseFloatField(value) {
  const trimmed = value.trim();
  if (!decimalFloat.test(trimmed)) return 0;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : 0;
}
function parseIntField(value) {
  const trimmed = value.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) return 0;
  const parsed = Number(trimmed);
  return parsed < 0 || !Number.isSafeInteger(parsed) ? 0 : parsed;
}
function atoi(value) {
  if (!/^[+-]?\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
function splitRational(value) {
  const trimmed = value.trim();
  const slash = trimmed.indexOf("/");
  if (slash < 0) return [0, 0];
  const n = atoi(trimmed.slice(0, slash));
  const d = atoi(trimmed.slice(slash + 1));
  if (n === null || d === null || d === 0) return [0, 0];
  return [n, d];
}
function parseRational(value) {
  const [n, d] = splitRational(value);
  if (d === 0) return 0;
  return n / d;
}

// ../engine/src/mediaprobe/run.ts
var import_node_child_process4 = require("node:child_process");
var signalText = {
  SIGKILL: "killed",
  SIGTERM: "terminated",
  SIGINT: "interrupt",
  SIGSEGV: "segmentation fault",
  SIGABRT: "abort trap",
  SIGPIPE: "broken pipe",
  SIGHUP: "hangup"
};
function spawnErrorText(command, err) {
  const code = err.code;
  const text = code === "ENOENT" ? "no such file or directory" : code === "EACCES" ? "permission denied" : err.message;
  return `fork/exec ${command}: ${text}`;
}
function exitText(status, signal) {
  if (signal) return `signal: ${signalText[signal] ?? signal}`;
  if (status !== 0) return `exit status ${status}`;
  return null;
}
function fromSync(command, result) {
  const stdout = result.stdout ?? Buffer.alloc(0);
  const stderr = result.stderr ?? Buffer.alloc(0);
  if (result.error) return { stdout, stderr, error: spawnErrorText(command, result.error), exited: false };
  const error = exitText(result.status, result.signal);
  return { stdout, stderr, error, exited: error !== null };
}
function run(command, args, env) {
  return fromSync(command, (0, import_node_child_process4.spawnSync)(command, args, { env, maxBuffer: 1 << 30, stdio: ["ignore", "pipe", "pipe"] }));
}
function combined(ran) {
  return Buffer.concat([ran.stdout, ran.stderr]).toString("utf8");
}
function commandError(ran, stderrCaptured = true) {
  if (stderrCaptured && ran.exited && ran.stderr.length > 0) return firstLine(ran.stderr.toString("utf8"));
  return ran.error ?? "";
}
function firstLine(value) {
  let trimmed = value.trim();
  const index = trimmed.indexOf("\n");
  if (index >= 0) trimmed = trimmed.slice(0, index);
  const bytes2 = Buffer.from(trimmed, "utf8");
  if (bytes2.length > 200) trimmed = bytes2.subarray(0, 200).toString("utf8");
  return trimmed === "" ? "\u65E0\u8F93\u51FA" : trimmed;
}
function runAsync(command, args, env, options = {}) {
  return new Promise((resolve3) => {
    if (options.signal?.aborted) {
      resolve3({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), error: "context canceled", exited: false });
      return;
    }
    const child = (0, import_node_child_process4.spawn)(command, args, {
      env,
      signal: options.signal,
      killSignal: "SIGKILL",
      stdio: ["ignore", options.captureStdout ? "pipe" : "ignore", options.captureStderr ? "pipe" : "ignore"]
    });
    const out = [];
    const err = [];
    child.stdout?.on("data", (chunk) => out.push(chunk));
    child.stderr?.on("data", (chunk) => err.push(chunk));
    let settled = false;
    const settle = (ran) => {
      if (!settled) {
        settled = true;
        resolve3(ran);
      }
    };
    child.on("error", (e) => {
      if (child.pid === void 0 && e.code !== "ABORT_ERR") {
        settle({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), error: spawnErrorText(command, e), exited: false });
      }
    });
    child.on("close", (status, signal) => {
      const error = exitText(status, signal);
      settle({ stdout: Buffer.concat(out), stderr: Buffer.concat(err), error, exited: error !== null });
    });
  });
}

// ../engine/src/mediaprobe/loudness.ts
var loudnessSampleRate = 16e3;
var SilenceFloorDB = -120;
function loudness(t, file, windowSeconds) {
  if (!(windowSeconds > 0) || !Number.isFinite(windowSeconds)) {
    throw new Error(`\u54CD\u5EA6\u7A97\u53E3\u5FC5\u987B\u662F\u6B63\u6570\uFF0C\u6536\u5230 ${formatG(windowSeconds)}`);
  }
  const window = goRound(windowSeconds * loudnessSampleRate);
  if (window < 1) throw new Error(`\u54CD\u5EA6\u7A97\u53E3\u592A\u77ED\uFF1A${formatG(windowSeconds)} \u79D2`);
  const ffmpeg = t.ffmpegPath();
  const ran = run(ffmpeg, ["-v", "error", "-i", file, "-vn", "-ac", "1", "-ar", String(loudnessSampleRate), "-f", "s16le", "-acodec", "pcm_s16le", "-"], t.env);
  if (ran.error) throw new Error(`\u65E0\u6CD5\u89E3\u7801\u97F3\u9891\uFF1A${file}\uFF08${commandError(ran)}\uFF09`);
  const output2 = ran.stdout;
  const samples = Math.floor(output2.length / 2);
  if (samples === 0) throw new Error(`\u97F3\u9891\u91CC\u6CA1\u6709\u53EF\u89E3\u7801\u7684\u91C7\u6837\uFF1A${file}`);
  const levels = [];
  for (let start = 0; start < samples; start += window) {
    const end = Math.min(start + window, samples);
    let sum = 0;
    for (let i = start; i < end; i++) {
      const value = output2.readInt16LE(2 * i) / 32768;
      sum += value * value;
    }
    levels.push(rmsToDB(Math.sqrt(sum / (end - start))));
  }
  return levels;
}
function rmsToDB(rms) {
  if (rms <= 0) return SilenceFloorDB;
  return Math.max(SilenceFloorDB, 20 * Math.log10(rms));
}
function measureProgramLoudness(t, file) {
  const ffmpeg = t.ffmpegPath();
  const ran = run(ffmpeg, ["-hide_banner", "-nostats", "-nostdin", "-i", file, "-vn", "-af", "loudnorm=print_format=json", "-f", "null", "-"], t.env);
  if (ran.error) throw new Error(`\u65E0\u6CD5\u6D4B\u91CF\u54CD\u5EA6\uFF1A${file}\uFF08${commandError(ran, false)}\uFF09`);
  return parseLoudnorm(ran.stderr.toString("utf8"));
}
function goParseFloat(value) {
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(value)) return Number(value);
  const special = /^([+-]?)(inf|infinity)$/i.exec(value);
  if (special) return special[1] === "-" ? -Infinity : Infinity;
  if (/^nan$/i.test(value)) return NaN;
  return null;
}
function parseLoudnorm(log) {
  const start = log.lastIndexOf("{");
  const end = log.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("loudnorm \u6CA1\u6709\u8F93\u51FA\u6D4B\u91CF\u7ED3\u679C");
  let raw;
  try {
    raw = JSON.parse(log.slice(start, end + 1));
  } catch (err) {
    throw new Error(`loudnorm \u6D4B\u91CF\u7ED3\u679C\u65E0\u6CD5\u89E3\u6790\uFF1A${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  const fields2 = ["input_i", "input_tp", "input_lra"].map((key) => {
    const value = raw?.[key];
    if (value !== void 0 && value !== null && typeof value !== "string") {
      throw new Error(`loudnorm \u6D4B\u91CF\u7ED3\u679C\u65E0\u6CD5\u89E3\u6790\uFF1Ajson: cannot unmarshal ${typeof value} into Go struct field .${key} of type string`);
    }
    return value ?? "";
  });
  const values = fields2.map((field) => {
    const value = goParseFloat(field.trim());
    if (value === null || Number.isNaN(value)) throw new Error(`loudnorm \u6D4B\u91CF\u503C ${goQuote(field)} \u4E0D\u662F\u6570\u5B57`);
    return Math.max(SilenceFloorDB, value);
  });
  return { integrated_lufs: values[0], true_peak_dbtp: values[1], range_lu: values[2] };
}

// ../engine/src/mediaprobe/toolchain.ts
var import_node_fs19 = __toESM(require("node:fs"), 1);
var import_node_path16 = __toESM(require("node:path"), 1);

// ../engine/src/mediaprobe/beat.ts
var clickSampleRate = 48e3;
var clickSeconds = 0.035;
var clickDownbeatHz = 1760;
var clickBeatHz = 880;
var clickDownbeatLevel = 0.55;
var clickBeatLevel = 0.3;
var clickMusicLevel = 0.5;
var clickMatchSeconds = 2e-3;
async function decodeAnalysisWAV(t, source, dest, sampleRate, signal) {
  if (sampleRate <= 0) throw new Error(`\u5206\u6790\u91C7\u6837\u7387\u5FC5\u987B\u4E3A\u6B63\uFF0C\u6536\u5230 ${sampleRate}`);
  await t.transcode(dest, ["-i", source, "-vn", "-ac", "1", "-ar", String(sampleRate), "-c:a", "pcm_s16le"], signal);
}
async function clickTrack(t, music, dest, beats, downbeats, signal) {
  const ffmpeg = t.ffmpegPath();
  const args = ["-v", "error", "-nostdin", "-i", music, "-vn", "-ac", "2", "-ar", String(clickSampleRate), "-f", "s16le", "-acodec", "pcm_s16le", "-"];
  const ran = await t.runAsync(ffmpeg, args, { signal, captureStdout: true, captureStderr: true });
  if (ran.error) throw new Error(`\u65E0\u6CD5\u89E3\u7801\u97F3\u4E50\uFF1A${music}\uFF08${commandError(ran)}\uFF09`);
  const pcm = ran.stdout;
  const frames3 = Math.floor(pcm.length / 4);
  const mix = new Float64Array(frames3 * 2);
  for (let i = 0; i < mix.length; i++) mix[i] = pcm.readInt16LE(2 * i) / 32768 * clickMusicLevel;
  for (const b of beats) {
    let hz = clickBeatHz;
    let level = clickBeatLevel;
    if (nearAny(b, downbeats, clickMatchSeconds)) {
      hz = clickDownbeatHz;
      level = clickDownbeatLevel;
    }
    addClick(mix, goRound(b * clickSampleRate), hz, level);
  }
  writeWAV(dest, mix, clickSampleRate, 2);
}
function nearAny(value, sorted, tolerance) {
  return sorted.some((candidate2) => Math.abs(candidate2 - value) <= tolerance);
}
function addClick(mix, start, hz, level) {
  const length = Math.trunc(clickSeconds * clickSampleRate);
  for (let i = 0; i < length; i++) {
    const frame = start + i;
    if (frame < 0 || 2 * frame + 1 >= mix.length) continue;
    const t = i / clickSampleRate;
    const value = level * Math.sin(2 * Math.PI * hz * t) * Math.exp(-t / (clickSeconds / 5));
    mix[2 * frame] += value;
    mix[2 * frame + 1] += value;
  }
}
function writeWAV(dest, samples, sampleRate, channels) {
  const data = Buffer.alloc(44 + 2 * samples.length);
  data.write("RIFF", 0, "latin1");
  data.writeUInt32LE(36 + 2 * samples.length >>> 0, 4);
  data.write("WAVEfmt ", 8, "latin1");
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(channels & 65535, 22);
  data.writeUInt32LE(sampleRate >>> 0, 24);
  data.writeUInt32LE(sampleRate * channels * 2 >>> 0, 28);
  data.writeUInt16LE(channels * 2 & 65535, 32);
  data.writeUInt16LE(16, 34);
  data.write("data", 36, "latin1");
  data.writeUInt32LE(2 * samples.length >>> 0, 40);
  for (let i = 0; i < samples.length; i++) {
    let s = samples[i];
    if (Math.abs(s) > 0.9) {
      const magnitude = 0.9 + 0.1 * Math.tanh((Math.abs(s) - 0.9) / 0.1);
      s = s < 0 || Object.is(s, -0) ? -magnitude : magnitude;
    }
    data.writeUInt16LE(goRound(s * 32767) & 65535, 44 + 2 * i);
  }
  atomicWrite(dest, data, 420);
}

// ../engine/src/mediaprobe/contact.ts
var import_node_fs18 = __toESM(require("node:fs"), 1);
var import_node_path14 = __toESM(require("node:path"), 1);
var contactSheetPadding = 8;
var contactSheetBackground = "0x303030";
function contactSheetRegion(t, file, atSeconds, region, columns, thumbWidth, dest) {
  if (atSeconds.length === 0) throw new Error("\u8054\u7CFB\u8868\u81F3\u5C11\u9700\u8981\u4E00\u4E2A\u65F6\u95F4\u70B9");
  if (columns < 1 || thumbWidth < 16) {
    throw new Error(`\u8054\u7CFB\u8868\u5217\u6570\u5FC5\u987B \u2265 1\u3001\u7F29\u7565\u56FE\u5BBD\u5EA6\u5FC5\u987B \u2265 16\uFF0C\u6536\u5230 ${columns} \u5217\u3001${thumbWidth} \u50CF\u7D20`);
  }
  const ffmpeg = t.ffmpegPath();
  import_node_fs18.default.mkdirSync(import_node_path14.default.dirname(dest), { recursive: true });
  const workDir = import_node_fs18.default.mkdtempSync(import_node_path14.default.join(import_node_path14.default.dirname(dest), ".contact-"));
  try {
    atSeconds.forEach((at, i) => {
      const thumb = import_node_path14.default.join(workDir, `thumb-${String(i + 1).padStart(4, "0")}.png`);
      const ran2 = run(
        ffmpeg,
        ["-v", "error", "-y", "-ss", formatSeconds(at), "-i", file, "-frames:v", "1", "-vf", joinFilters(regionFilter(region), `scale=${thumbWidth}:-2`), "-f", "image2", "-c:v", "png", thumb],
        t.env
      );
      if (ran2.error) throw new Error(`\u8054\u7CFB\u8868\u62BD\u5E27\u5931\u8D25\uFF1A${file} @ ${formatFixed(at, 3)} \u79D2\uFF08${firstLine(combined(ran2))}\uFF09`);
      if (!nonEmpty(thumb)) throw new Error(`\u8054\u7CFB\u8868\u62BD\u5E27\u6CA1\u6709\u4EA7\u51FA\u5185\u5BB9\uFF1A${file} @ ${formatFixed(at, 3)} \u79D2\uFF08\u65F6\u95F4\u70B9\u53EF\u80FD\u8D85\u51FA\u89C6\u9891\u65F6\u957F\uFF09`);
    });
    const rows = Math.floor((atSeconds.length + columns - 1) / columns);
    const ran = run(
      ffmpeg,
      [
        "-v",
        "error",
        "-y",
        "-framerate",
        "1",
        "-start_number",
        "1",
        "-i",
        import_node_path14.default.join(workDir, "thumb-%04d.png"),
        "-vf",
        `tile=${columns}x${rows}:padding=${contactSheetPadding}:margin=${contactSheetPadding}:color=${contactSheetBackground}`,
        "-frames:v",
        "1",
        "-f",
        "image2",
        "-c:v",
        "png",
        dest
      ],
      t.env
    );
    if (ran.error) throw new Error(`\u62FC\u63A5\u8054\u7CFB\u8868\u5931\u8D25\uFF1A${dest}\uFF08${firstLine(combined(ran))}\uFF09`);
    if (!nonEmpty(dest)) throw new Error(`\u8054\u7CFB\u8868\u6CA1\u6709\u4EA7\u51FA\u5185\u5BB9\uFF1A${dest}`);
  } finally {
    import_node_fs18.default.rmSync(workDir, { recursive: true, force: true });
  }
}
function nonEmpty(file) {
  try {
    return import_node_fs18.default.statSync(file).size > 0;
  } catch {
    return false;
  }
}

// ../engine/src/mediaprobe/song.ts
var import_node_path15 = __toESM(require("node:path"), 1);
async function prepareAlignment(t, source, dest, signal) {
  await t.transcode(dest, ["-i", source, "-vn", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le"], signal);
}
var songAACBitrate = "384k";
function formatList(values) {
  return `[${values.join(" ")}]`;
}
async function muxSong(t, video, audio, dest, duration, fps, signal) {
  if (fps <= 0 || !Number.isFinite(duration) || duration <= 0) throw new Error("\u6B4C\u66F2\u65F6\u957F\u6216\u5E27\u7387\u65E0\u6548");
  const frames3 = Math.ceil(duration * fps - 1e-9);
  const target = frames3 / fps;
  for (const p of [video, audio]) {
    if (import_node_path15.default.resolve(p) === import_node_path15.default.resolve(dest)) throw new Error("\u8F93\u51FA\u4E0D\u5F97\u8986\u76D6\u8F93\u5165");
  }
  const m = t.probe(audio);
  if (!m.audio || m.video || Math.abs(m.duration_seconds - duration) > 1e-6) {
    throw new Error("\u9009\u5B9A\u6B4C\u66F2\u97F3\u9891\u89C4\u683C\u6216\u65F6\u957F\u4E0D\u4E00\u81F4");
  }
  let report = t.verify(video, {
    spec: { fps, frames: frames3, durationSeconds: target, tolerance: 1e-3, audio: AudioAbsent },
    exactFrames: true
  });
  if (!report.ok) throw new Error(`\u6B4C\u66F2\u9759\u97F3\u6BCD\u7248\u4E0D\u5408\u683C\uFF1A${formatList(report.problems)}`);
  const filter = "apad=pad_dur=" + formatFixed(Math.max(0, target - duration), 9) + ",atrim=duration=" + formatFixed(target, 9);
  await t.transcode(
    dest,
    ["-i", video, "-i", audio, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-af", filter, "-c:a", "aac", "-b:a", songAACBitrate, "-ar", "48000", "-ac", "2", "-movflags", "+faststart"],
    signal
  );
  report = t.verify(dest, {
    spec: { fps, frames: frames3, durationSeconds: target, tolerance: 1 / fps, audio: AudioPresent, sampleRate: 48e3, channels: 2 },
    exactFrames: true,
    decode: true
  });
  if (!report.ok) throw new Error(`\u6B4C\u66F2\u6210\u7247\u4E0D\u5408\u683C\uFF1A${formatList(report.problems)}`);
}

// ../engine/src/mediaprobe/toolchain.ts
var statsSampleSize = 128;
var differenceSampleSize = 32;
function formatSecondsShort(value) {
  let text = formatFixed(value, 3).replace(/0+$/, "");
  if (text.endsWith(".")) text = text.slice(0, -1);
  return text;
}
function newToolchain(env) {
  const ffprobe = lookPath("ffprobe", env.PATH ?? "");
  return new Toolchain(ffprobe, env.PATH ?? "", { ...env });
}
var Toolchain = class {
  /** 用 newToolchain 构造。 */
  constructor(ffprobe, pathValue, env) {
    this.ffprobe = ffprobe;
    this.pathValue = pathValue;
    this.env = env;
  }
  ffprobe;
  pathValue;
  env;
  /** 在真正需要 ffmpeg 的操作里解析它。 */
  ffmpegPath() {
    return lookPath("ffmpeg", this.pathValue);
  }
  /** 异步跑一条命令（Go 的 exec.CommandContext）。 */
  runAsync(command, args, options = {}) {
    return runAsync(command, args, this.env, options);
  }
  /** 读取媒体文件的实测规格。不解码，只读容器和流头，代价与文件长度无关。 */
  probe(file) {
    const ran = run(this.ffprobe, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file], this.env);
    if (ran.error) throw new Error(`\u65E0\u6CD5\u8BFB\u53D6\u5A92\u4F53\u89C4\u683C\uFF1A${file}\uFF08${commandError(ran)}\uFF09`);
    return parse2(ran.stdout.toString("utf8"), file);
  }
  /**
   * 解码整个文件精确统计帧数。
   *
   * 与 probe 读到的 nb_frames 不同：容器声明的帧数可能缺失或不准，
   * 而验收要断言的是「总帧数等于冻结时间轴的总帧数」。代价是完整解码一遍，
   * 所以只在确实需要精确帧数时调用。
   */
  countFrames(file) {
    const ran = run(
      this.ffprobe,
      ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-print_format", "json", file],
      this.env
    );
    if (ran.error) throw new Error(`\u65E0\u6CD5\u7EDF\u8BA1\u5E27\u6570\uFF1A${file}\uFF08${commandError(ran)}\uFF09`);
    let raw;
    try {
      raw = JSON.parse(ran.stdout.toString("utf8"));
    } catch (err) {
      throw new Error(`ffprobe \u5E27\u6570\u8F93\u51FA\u4E0D\u662F\u5408\u6CD5 JSON\uFF1A${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    for (const stream of raw?.streams ?? []) {
      const frames3 = parseIntField(typeof stream.nb_read_frames === "string" ? stream.nb_read_frames : "");
      if (frames3 > 0) return frames3;
    }
    throw new Error(`ffprobe \u672A\u80FD\u7EDF\u8BA1\u51FA\u5E27\u6570\uFF1A${file}`);
  }
  /** 完整解码一遍，确认文件没有截断或损坏。产物丢弃。 */
  decode(file) {
    const ffmpeg = this.ffmpegPath();
    const ran = run(ffmpeg, ["-v", "error", "-xerror", "-i", file, "-f", "null", "-"], this.env);
    const output2 = combined(ran);
    if (ran.error) throw new Error(`\u65E0\u6CD5\u5B8C\u6574\u89E3\u7801\uFF1A${file}\uFF08${firstLine(output2)}\uFF09`);
    const trimmed = output2.trim();
    if (trimmed !== "") throw new Error(`\u89E3\u7801\u8FC7\u7A0B\u4E2D\u62A5\u9519\uFF1A${file}\uFF08${firstLine(trimmed)}\uFF09`);
  }
  /** 抽取 atSeconds 处的一帧写成 PNG，自动建立目标目录。 */
  extractFrame(file, atSeconds, dest) {
    this.extractFrameRegion(file, atSeconds, null, dest);
  }
  /**
   * 同 extractFrame，region 非空时只保留该区域的原始像素，
   * 用于在全分辨率下看小字、细线这类缩略图上看不清的细节。
   */
  extractFrameRegion(file, atSeconds, region, dest) {
    import_node_fs19.default.mkdirSync(import_node_path16.default.dirname(dest), { recursive: true });
    const ffmpeg = this.ffmpegPath();
    const argv = ["-v", "error", "-y", "-ss", formatSeconds(atSeconds), "-i", file, "-frames:v", "1"];
    const filter = regionFilter(region);
    if (filter !== "") argv.push("-vf", filter);
    const ran = run(ffmpeg, [...argv, "-f", "image2", "-c:v", "png", dest], this.env);
    if (ran.error) throw new Error(`\u62BD\u5E27\u5931\u8D25\uFF1A${file} @ ${formatFixed(atSeconds, 3)} \u79D2\uFF08${firstLine(combined(ran))}\uFF09`);
    if (!nonEmpty(dest)) {
      import_node_fs19.default.rmSync(dest, { force: true });
      throw new Error(`\u62BD\u5E27\u6CA1\u6709\u4EA7\u51FA\u5185\u5BB9\uFF1A${file} @ ${formatFixed(atSeconds, 3)} \u79D2\uFF08\u65F6\u95F4\u70B9\u53EF\u80FD\u8D85\u51FA\u89C6\u9891\u65F6\u957F\uFF09`);
    }
  }
  /**
   * 抽取 atSeconds 处的一帧，缩放成灰度小图后在本进程里计算均值和标准差。
   *
   * 不用 ffmpeg 的 signalstats/blackdetect：它们把结果写进 stderr 的文本日志，
   * 格式随版本变化，解析起来比自己算更脆。裸灰度像素是稳定接口。
   */
  frameStats(file, atSeconds) {
    const ffmpeg = this.ffmpegPath();
    const output2 = this.rawFrame(ffmpeg, file, atSeconds, statsSampleSize, "gray");
    let sum = 0;
    for (const pixel of output2) sum += pixel;
    const mean = sum / output2.length;
    let variance = 0;
    for (const pixel of output2) {
      const delta = pixel - mean;
      variance += delta * delta;
    }
    variance /= output2.length;
    return { at_seconds: atSeconds, mean, stddev: Math.sqrt(variance) };
  }
  /** 抽取 atSeconds 处的一帧，缩放成 size×size 的指定像素格式后返回裸像素。 */
  rawFrame(ffmpeg, file, atSeconds, size, pixelFormat) {
    const ran = run(
      ffmpeg,
      ["-v", "error", "-ss", formatSeconds(atSeconds), "-i", file, "-frames:v", "1", "-vf", `scale=${size}:${size},format=${pixelFormat}`, "-f", "rawvideo", "-"],
      this.env
    );
    if (ran.error) throw new Error(`\u8BFB\u53D6\u5E27\u50CF\u7D20\u5931\u8D25\uFF1A${file} @ ${formatFixed(atSeconds, 3)} \u79D2\uFF08${commandError(ran)}\uFF09`);
    if (ran.stdout.length === 0) throw new Error(`\u8BE5\u65F6\u95F4\u70B9\u6CA1\u6709\u5E27\uFF1A${file} @ ${formatFixed(atSeconds, 3)} \u79D2`);
    return ran.stdout;
  }
  /**
   * 抽取 a、b 两个时间点的帧，缩放成 32×32 的 RGB 小图，返回逐通道
   * 绝对差的均值（0–255）。0 是完全相同，两张无关画面通常在 40 以上。
   */
  frameDifference(file, a, b) {
    const ffmpeg = this.ffmpegPath();
    const first = this.rawFrame(ffmpeg, file, a, differenceSampleSize, "rgb24");
    const second = this.rawFrame(ffmpeg, file, b, differenceSampleSize, "rgb24");
    return meanAbsoluteDifference(first, second);
  }
  /**
   * 跑完整的校验流程并返回机器可读报告。
   *
   * 抛出的错误只表示「检查没跑成」（文件读不了、工具缺失），
   * 「检查跑了但不合格」体现为 report.ok 为 false 和 problems 非空——
   * 两者对调用方的含义完全不同，混在一起会让退出码失去区分度。
   */
  verify(file, opts = {}) {
    const spec = opts.spec ?? {};
    validateSpec(spec);
    const media = this.probe(file);
    const report = { schema_version: ReportSchemaVersion3, path: file, ok: false, media, problems: [] };
    if (opts.exactFrames && media.video) {
      media.video.nb_frames = this.countFrames(file);
    }
    report.problems = checkSpec(spec, media);
    if (opts.decode) {
      try {
        this.decode(file);
      } catch (err) {
        report.problems.push(err instanceof Error ? err.message : String(err));
      }
    }
    if (opts.checkFrameZero) {
      const stats = this.frameStats(file, 0);
      report.frame_zero = stats;
      if (isBlank(stats)) {
        report.problems.push(`\u7B2C 0 \u5E27\u662F\u7A7A\u767D\u5E27\uFF0C\u4E0D\u80FD\u4F5C\u4E3A\u5C01\u9762\uFF1A\u7070\u5EA6\u5747\u503C ${formatFixed(stats.mean, 1)}\u3001\u6807\u51C6\u5DEE ${formatFixed(stats.stddev, 2)}`);
      } else if (isDark(stats)) {
        (report.hints ??= []).push(`\u7B2C 0 \u5E27\u6574\u4F53\u504F\u6697\uFF08\u7070\u5EA6\u5747\u503C ${formatFixed(stats.mean, 1)}\uFF09\uFF0C\u786E\u8BA4\u6807\u9898\u5728\u76EE\u6807\u5E73\u53F0\u53EF\u8BFB`);
      }
    }
    report.ok = report.problems.length === 0;
    return report;
  }
  /**
   * 按给定时间点批量抽帧到 destDir，并统计每帧的灰度分布。
   *
   * 抽帧本身不判定对错——画面对不对只有能看图的一方说了算。这个方法的职责是
   * 把「渲染完的 mp4」变成「可以逐张看的 PNG」，顺带把纯色帧这种机器能判的
   * 情况标出来，省得靠人眼去发现一张全黑的图。
   */
  extractFrames(file, atSeconds, destDir) {
    return this.extractFramesRegion(file, atSeconds, null, destDir);
  }
  /** 同 extractFrames，PNG 只保留 region 区域；空白帧判定仍按整帧。 */
  extractFramesRegion(file, atSeconds, region, destDir) {
    const report = { schema_version: ReportSchemaVersion3, path: file, ok: false, frames: [], problems: [] };
    for (const at of atSeconds) {
      const image = import_node_path16.default.join(destDir, `frame-${formatSecondsShort(at).replaceAll(".", "_")}.png`);
      this.extractFrameRegion(file, at, region, image);
      const stats = this.frameStats(file, at);
      const frame = { at_seconds: at, image, stats, blank: isBlank(stats), dark: isDark(stats) };
      report.frames.push(frame);
      if (frame.blank) {
        report.problems.push(
          `${formatFixed(at, 3)} \u79D2\u5904\u662F\u7A7A\u767D\u5E27\uFF1A\u7070\u5EA6\u5747\u503C ${formatFixed(stats.mean, 1)}\u3001\u6807\u51C6\u5DEE ${formatFixed(stats.stddev, 2)}\uFF08${image}\uFF09`
        );
      } else if (frame.dark) {
        (report.hints ??= []).push(`${formatFixed(at, 3)} \u79D2\u5904\u6574\u4F53\u504F\u6697\uFF08\u7070\u5EA6\u5747\u503C ${formatFixed(stats.mean, 1)}\uFF09\uFF0C\u786E\u8BA4\u5185\u5BB9\u53EF\u8BFB\uFF08${image}\uFF09`);
      }
    }
    report.ok = report.problems.length === 0;
    return report;
  }
  /** 见 contact.ts 的 contactSheetRegion。 */
  contactSheet(file, atSeconds, columns, thumbWidth, dest) {
    contactSheetRegion(this, file, atSeconds, null, columns, thumbWidth, dest);
  }
  contactSheetRegion(file, atSeconds, region, columns, thumbWidth, dest) {
    contactSheetRegion(this, file, atSeconds, region, columns, thumbWidth, dest);
  }
  /** 见 loudness.ts。 */
  loudness(file, windowSeconds) {
    return loudness(this, file, windowSeconds);
  }
  measureProgramLoudness(file) {
    return measureProgramLoudness(this, file);
  }
  /** 见 beat.ts。 */
  decodeAnalysisWAV(source, dest, sampleRate, signal) {
    return decodeAnalysisWAV(this, source, dest, sampleRate, signal);
  }
  clickTrack(music, dest, beats, downbeats, signal) {
    return clickTrack(this, music, dest, beats, downbeats, signal);
  }
  /** 见 song.ts。 */
  prepareAlignment(source, dest, signal) {
    return prepareAlignment(this, source, dest, signal);
  }
  muxSong(video, audio, dest, duration, fps, signal) {
    return muxSong(this, video, audio, dest, duration, fps, signal);
  }
  /**
   * 在 dest 同目录的临时文件里转码，成功后改名到位；失败时删掉临时文件。
   * 与 Go 一样不接管 ffmpeg 的输出，错误只有「exit status N」。
   */
  async transcode(dest, args, signal) {
    const binary = this.ffmpegPath();
    import_node_fs19.default.mkdirSync(import_node_path16.default.dirname(dest), { recursive: true });
    const ext = import_node_path16.default.extname(dest);
    const name = import_node_path16.default.join(import_node_path16.default.dirname(dest), `.song-${Math.floor(Math.random() * 1e10)}${ext}`);
    import_node_fs19.default.writeFileSync(name, "", { flag: "wx", mode: 384 });
    try {
      const ran = await this.runAsync(binary, ["-v", "error", "-nostdin", "-y", ...args, name], { signal });
      if (ran.error) throw new Error(`\u5A92\u4F53\u5904\u7406\u5931\u8D25\uFF1A${commandError(ran, false)}`);
      import_node_fs19.default.renameSync(name, dest);
    } finally {
      import_node_fs19.default.rmSync(name, { force: true });
    }
  }
};

// ../engine/src/srt/srt.ts
var import_node_fs20 = __toESM(require("node:fs"), 1);
var timecodeLine = /^[\t\n\f\r ]*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})[\t\n\f\r ]*-->[\t\n\f\r ]*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/;
var maxLineBytes = 1024 * 1024;
function readLines(file) {
  let body;
  try {
    body = import_node_fs20.default.readFileSync(file);
  } catch (err) {
    if (err.code === "EISDIR") {
      throw new Error(`\u8BFB\u53D6\u5B57\u5E55\u5931\u8D25\uFF1A${goPathError("read", file, err)}`, { cause: err });
    }
    throw new Error(`\u65E0\u6CD5\u8BFB\u53D6\u5B57\u5E55\uFF1A${goPathError("open", file, err)}`, { cause: err });
  }
  const text = body.toString("utf8");
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.map((line2) => {
    if (Buffer.byteLength(line2) >= maxLineBytes) throw new Error("\u8BFB\u53D6\u5B57\u5E55\u5931\u8D25\uFF1Abufio.Scanner: token too long");
    return line2.endsWith("\r") ? line2.slice(0, -1) : line2;
  });
}
function clockSeconds(hours, minutes, seconds, millis) {
  const h = Number(hours);
  const m = Number(minutes);
  const s = Number(seconds);
  const ms = Number(millis + "0".repeat(3 - millis.length));
  if (m > 59 || s > 59) {
    throw new Error(`\u65F6\u95F4\u7801\u7684\u5206\u6216\u79D2\u8D85\u51FA\u8303\u56F4\uFF1A${hours}:${minutes}:${seconds},${millis}`);
  }
  return h * 3600 + m * 60 + s + ms * 1e6 / 1e9;
}
function readCues(file) {
  const cues = [];
  let current = null;
  let text = [];
  const flush = () => {
    if (current) {
      current.text = text.join("\n");
      cues.push(current);
    }
    current = null;
    text = [];
  };
  for (const raw of readLines(file)) {
    const line2 = raw.startsWith("\uFEFF") ? raw.slice(1) : raw;
    const match = timecodeLine.exec(line2);
    if (match) {
      flush();
      const start = clockSeconds(match[1], match[2], match[3], match[4]);
      const end = clockSeconds(match[5], match[6], match[7], match[8]);
      if (end < start) {
        throw new Error(`\u7B2C ${cues.length + 1} \u6761\u5B57\u5E55\u7684\u7ED3\u675F\u65F6\u95F4\u65E9\u4E8E\u5F00\u59CB\u65F6\u95F4\uFF1A${line2.trim()}`);
      }
      current = { index: cues.length + 1, start_seconds: start, end_seconds: end, text: "" };
      continue;
    }
    const trimmed = line2.trim();
    if (!current) continue;
    if (trimmed === "") {
      flush();
      continue;
    }
    text.push(trimmed);
  }
  flush();
  if (cues.length === 0) throw new Error(`\u5B57\u5E55\u91CC\u6CA1\u6709\u4EFB\u4F55\u65F6\u95F4\u7801\uFF1A${file}`);
  return cues;
}

// ../engine/src/voicecheck/voicecheck.ts
var Defaults2 = Object.freeze({
  window: 0.01,
  belowPeakDB: 35,
  minGap: 0.12,
  minSpeech: 0.05,
  tolerance: 0.2,
  minUncovered: 0.3
});
function withDefaults(o) {
  const pick = (value, fallback) => value === void 0 || value <= 0 ? fallback : value;
  return {
    window: pick(o.window, Defaults2.window),
    belowPeakDB: pick(o.belowPeakDB, Defaults2.belowPeakDB),
    minGap: pick(o.minGap, Defaults2.minGap),
    minSpeech: pick(o.minSpeech, Defaults2.minSpeech),
    tolerance: pick(o.tolerance, Defaults2.tolerance),
    minUncovered: pick(o.minUncovered, Defaults2.minUncovered)
  };
}
var ReportSchemaVersion4 = 1;
function writeReportJSON2(report, target) {
  const body = marshalIndent({
    schema_version: report.schema_version,
    ok: report.ok,
    threshold_db: report.threshold_db,
    speech: report.speech.map((s) => ({ start: s.start, end: s.end })),
    cues: report.cues.map((c) => ({
      index: c.index,
      start: c.start,
      end: c.end,
      text: c.text,
      speech_start: c.speech_start,
      speech_end: c.speech_end,
      start_delta: c.start_delta,
      end_delta: c.end_delta,
      owns_onset: c.owns_onset
    })),
    median_start_delta: report.median_start_delta,
    problems: report.problems,
    hints: report.hints && report.hints.length > 0 ? report.hints : void 0
  });
  atomicWrite(target, body + "\n", 420);
}
var quietestSpeechDB = -60;
function speech(levels, options = {}) {
  const opts = withDefaults(options);
  let peak = -Infinity;
  for (const level of levels) peak = Math.max(peak, level);
  const threshold = peak - opts.belowPeakDB;
  if (peak < quietestSpeechDB) return [[], threshold];
  const raw = [];
  let start = -1;
  levels.forEach((level, i) => {
    const loud = level >= threshold;
    if (loud && start < 0) {
      start = i;
    } else if (!loud && start >= 0) {
      raw.push({ start: start * opts.window, end: i * opts.window });
      start = -1;
    }
  });
  if (start >= 0) raw.push({ start: start * opts.window, end: levels.length * opts.window });
  const merged = [];
  for (const segment of raw) {
    const n = merged.length;
    if (n > 0 && segment.start - merged[n - 1].end < opts.minGap) {
      merged[n - 1].end = segment.end;
      continue;
    }
    merged.push({ ...segment });
  }
  const out = [];
  for (const segment of merged) {
    if (segment.end - segment.start >= opts.minSpeech) out.push(round(segment));
  }
  return [out, threshold];
}
function round(s) {
  return { start: goRound(s.start * 1e3) / 1e3, end: goRound(s.end * 1e3) / 1e3 };
}
function check2(cues, speechSegments, threshold, options = {}) {
  const opts = withDefaults(options);
  const report = {
    schema_version: ReportSchemaVersion4,
    ok: false,
    threshold_db: goRound(threshold * 10) / 10,
    speech: speechSegments ?? [],
    cues: [],
    problems: []
  };
  if (speechSegments.length === 0) {
    report.problems.push("\u97F3\u9891\u91CC\u6CA1\u6709\u68C0\u6D4B\u5230\u4EFB\u4F55\u53D1\u58F0");
    return report;
  }
  const deltas = [];
  for (const cue of cues) {
    if (cue.end_seconds <= cue.start_seconds) {
      addHint(
        report,
        `\u7B2C ${cue.index} \u6761\u5B57\u5E55\u65F6\u957F\u4E3A 0\uFF08${formatFixed(cue.start_seconds, 3)} \u79D2\uFF09\uFF0C\u672A\u53C2\u4E0E\u6BD4\u5BF9\uFF1B\u82E5\u4E0D\u662F\u7EAF\u6807\u70B9\u6761\u76EE\uFF0C\u68C0\u67E5\u65F6\u95F4\u6233\u6765\u6E90`
      );
      continue;
    }
    const result = checkCue(report, cue, speechSegments, opts);
    if (result.owns_onset) deltas.push(result.start_delta);
    report.cues.push(result);
  }
  checkUncovered(report, cues, speechSegments, opts);
  if (deltas.length > 0) {
    const median = medianOf(deltas);
    report.median_start_delta = median;
    if (Math.abs(median) > opts.tolerance / 2) {
      const direction = median > 0 ? "\u665A" : "\u65E9";
      addHint(
        report,
        `\u5B57\u5E55\u6574\u4F53\u6BD4\u58F0\u97F3${direction}\u7EA6 ${formatFixed(Math.abs(median), 3)} \u79D2\uFF1A\u591A\u6761\u540C\u5411\u504F\u79FB\u8BF4\u660E\u65F6\u95F4\u6233\u6765\u6E90\u6709\u7CFB\u7EDF\u8BEF\u5DEE\uFF0C\u4F18\u5148\u6574\u4F53\u6821\u6B63\u800C\u4E0D\u662F\u9010\u6761\u4FEE`
      );
    }
  }
  report.ok = report.problems.length === 0;
  return report;
}
function addHint(report, hint) {
  (report.hints ??= []).push(hint);
}
function checkCue(report, cue, speechSegments, opts) {
  const result = { index: cue.index, start: cue.start_seconds, end: cue.end_seconds, text: cue.text, owns_onset: false };
  const [first, last] = meaningfulOverlap(cue, speechSegments, opts.tolerance);
  if (first < 0) {
    report.problems.push(
      `\u7B2C ${cue.index} \u6761\u5B57\u5E55\uFF08${formatFixed(cue.start_seconds, 3)}\u2013${formatFixed(cue.end_seconds, 3)} \u79D2\uFF09\u6574\u6BB5\u843D\u5728\u9759\u97F3\u91CC\uFF1A${cue.text}`
    );
    return result;
  }
  const speechStart = speechSegments[first].start;
  const speechEnd = speechSegments[last].end;
  const startDelta = roundMillis(cue.start_seconds - speechStart);
  const endDelta = roundMillis(cue.end_seconds - speechEnd);
  result.speech_start = speechStart;
  result.speech_end = speechEnd;
  result.start_delta = startDelta;
  result.end_delta = endDelta;
  result.owns_onset = !previousCueCovers(report, speechStart);
  if (startDelta < -opts.tolerance) {
    report.problems.push(
      `\u7B2C ${cue.index} \u6761\u5B57\u5E55\u6BD4\u58F0\u97F3\u65E9 ${formatFixed(-startDelta, 3)} \u79D2\u5F00\u59CB\uFF08\u5B57\u5E55 ${formatFixed(cue.start_seconds, 3)} \u79D2\uFF0C\u53D1\u58F0 ${formatFixed(speechStart, 3)} \u79D2\uFF09\uFF1A${cue.text}`
    );
  } else if (startDelta > opts.tolerance && result.owns_onset) {
    report.problems.push(
      `\u7B2C ${cue.index} \u6761\u5B57\u5E55\u6BD4\u58F0\u97F3\u665A ${formatFixed(startDelta, 3)} \u79D2\u5F00\u59CB\uFF08\u5B57\u5E55 ${formatFixed(cue.start_seconds, 3)} \u79D2\uFF0C\u53D1\u58F0 ${formatFixed(speechStart, 3)} \u79D2\uFF09\uFF1A${cue.text}`
    );
  }
  if (endDelta > opts.tolerance) {
    addHint(
      report,
      `\u7B2C ${cue.index} \u6761\u5B57\u5E55\u5728\u58F0\u97F3\u7ED3\u675F\u540E\u53C8\u505C\u7559 ${formatFixed(endDelta, 3)} \u79D2\uFF1A\u82E5\u8FD9\u662F TTS \u6216\u5BF9\u9F50\u76F4\u63A5\u4EA7\u51FA\u7684\u65F6\u95F4\u6233\uFF0C\u8BF4\u660E\u5B83\u504F\u665A`
    );
  }
  return result;
}
function meaningfulOverlap(cue, speechSegments, tolerance) {
  let first = -1;
  let last = -1;
  let anyFirst = -1;
  let anyLast = -1;
  speechSegments.forEach((segment, i) => {
    if (segment.end <= cue.start_seconds || segment.start >= cue.end_seconds) return;
    if (anyFirst < 0) anyFirst = i;
    anyLast = i;
    if (first < 0 && segment.end > cue.start_seconds + tolerance) first = i;
    if (segment.start < cue.end_seconds - tolerance) last = i;
  });
  if (first < 0 || last < 0 || first > last) return [anyFirst, anyLast];
  return [first, last];
}
function previousCueCovers(report, at) {
  return report.cues.some((previous) => previous.start <= at && at < previous.end);
}
function checkUncovered(report, cues, speechSegments, opts) {
  const covered = cues.map((cue) => ({ start: cue.start_seconds, end: cue.end_seconds }));
  covered.sort((a, b) => a.start - b.start);
  for (const segment of speechSegments) {
    let cursor = segment.start;
    for (const cover of covered) {
      if (cover.end <= cursor || cover.start >= segment.end) continue;
      if (cover.start > cursor) reportGap(report, cursor, cover.start, opts);
      cursor = Math.max(cursor, cover.end);
      if (cursor >= segment.end) break;
    }
    if (cursor < segment.end) reportGap(report, cursor, segment.end, opts);
  }
}
function reportGap(report, start, end, opts) {
  if (end - start >= opts.minUncovered) {
    report.problems.push(
      `${formatFixed(start, 3)}\u2013${formatFixed(end, 3)} \u79D2\u6709\u58F0\u97F3\u4F46\u6CA1\u6709\u5B57\u5E55\u8986\u76D6\uFF08${formatFixed(end - start, 3)} \u79D2\uFF09`
    );
  }
}
function roundMillis(value) {
  return goRound(value * 1e3) / 1e3;
}
function medianOf(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return roundMillis((sorted[mid - 1] + sorted[mid]) / 2);
}

// src/audio.ts
function signedFixed(value, digits) {
  const text = formatFixed(value, digits);
  return text.startsWith("-") ? text : "+" + text;
}
function newAudioCommand(stdout) {
  const cmd = new Command({
    use: "audio",
    short: "\u914D\u97F3\u76F8\u5173\u68C0\u67E5",
    long: `\u914D\u97F3\u76F8\u5173\u7684\u673A\u5668\u68C0\u67E5\u3002

  check   \u628A\u5B57\u5E55\u65F6\u95F4\u8F74\u4E0E\u914D\u97F3\u91CC\u5B9E\u9645\u53D1\u58F0\u7684\u533A\u95F4\u9010\u6761\u6BD4\u5BF9\uFF0C\u62E6\u4E0B\u6574\u4F53\u504F\u79FB\u3001
          \u843D\u5728\u9759\u97F3\u91CC\u7684\u5B57\u5E55\u4E0E\u6CA1\u6709\u5B57\u5E55\u8986\u76D6\u7684\u53D1\u58F0

\u914D\u97F3\u672C\u8EAB\u7531\u7F16\u6392\u5DE5\u5177\u6309 TTS_PROVIDER \u751F\u6210\uFF0C\u5F3A\u5236\u5BF9\u9F50\u6309 ALIGN_PROVIDER \u6267\u884C\uFF1B
\u8FD9\u91CC\u53EA\u505A\u4E0E\u5DE5\u5177\u65E0\u5173\u3001\u7ED3\u679C\u786E\u5B9A\u7684\u6821\u9A8C\u3002`
  });
  cmd.addCommand(newAudioCheckCommand(stdout));
  return cmd;
}
function newAudioCheckCommand(stdout) {
  const audioPath = ref("");
  const srtPath = ref("");
  const reportPath = ref("");
  const tolerance = ref(Defaults2.tolerance);
  const belowPeakDB = ref(Defaults2.belowPeakDB);
  const minGap = ref(Defaults2.minGap);
  const minUncovered = ref(Defaults2.minUncovered);
  const cmd = new Command({
    use: "check",
    args: noArgs,
    short: "\u628A\u5B57\u5E55\u65F6\u95F4\u8F74\u4E0E\u914D\u97F3\u91CC\u5B9E\u9645\u53D1\u58F0\u7684\u533A\u95F4\u9010\u6761\u6BD4\u5BF9",
    long: `\u7528\u914D\u97F3\u7684\u80FD\u91CF\u5305\u7EDC\u72EC\u7ACB\u6821\u9A8C\u5B57\u5E55\u65F6\u95F4\u8F74\u3002

\u5B57\u5E55\u65F6\u95F4\u6765\u81EA TTS \u81EA\u5E26\u7684\u65F6\u95F4\u6233\u3001ASR \u8BC6\u522B\u6216\u5F3A\u5236\u5BF9\u9F50\uFF0C\u4E09\u8005\u90FD\u53EF\u80FD\u6574\u4F53\u504F\u79FB\u6216\u5C40\u90E8
\u9519\u4F4D\u2014\u2014\u5B9E\u6D4B TTS \u81EA\u5E26\u7684 SRT \u4F1A\u6BD4\u5B9E\u9645\u53D1\u58F0\u65E9\u7EA6 0.4 \u79D2\u3002\u5B57\u5E55\u3001\u955C\u5934\u5207\u70B9\u548C\u753B\u9762\u8282\u62CD
\u5168\u6302\u5728\u8FD9\u6761\u65F6\u95F4\u8F74\u4E0A\uFF0C\u5B83\u9519\u4E86\uFF0C\u4E0B\u6E38\u6CA1\u6709\u4EFB\u4F55\u73AF\u8282\u4F1A\u62A5\u9519\u3002

\u8FD9\u6761\u547D\u4EE4\u4E0D\u8BC6\u522B\u6587\u5B57\uFF0C\u53EA\u5224\u5B9A\u300C\u8FD9\u4E00\u523B\u6709\u6CA1\u6709\u58F0\u97F3\u300D\uFF1A\u7535\u5E73\u4F4E\u4E8E\u5168\u7247\u6700\u54CD\u5904
--below-peak-db \u5206\u8D1D\u5373\u89C6\u4E3A\u9759\u97F3\uFF0C\u77ED\u4E8E --min-gap \u7684\u9759\u97F3\u5E76\u5165\u53D1\u58F0\u3002\u5B83\u4E0E\u5B57\u5E55\u6765\u6E90
\u5B8C\u5168\u65E0\u5173\uFF0C\u6240\u4EE5\u80FD\u4EA4\u53C9\u6821\u9A8C\u4EFB\u4F55\u4E00\u79CD\u6765\u6E90\u3002

\u5224\u4E3A\u95EE\u9898\uFF08\u9000\u51FA\u7801 1\uFF09\uFF1A
  - \u5B57\u5E55\u5F00\u59CB\u65E9\u4E8E\u5176\u4E2D\u9996\u4E2A\u53D1\u58F0\u8D85\u8FC7 --tolerance \u79D2
  - \u5B57\u5E55\u5F00\u59CB\u665A\u4E8E\u53D1\u58F0\u8D85\u8FC7 --tolerance \u79D2\uFF0C\u4E14\u90A3\u6BB5\u53D1\u58F0\u4E0D\u5728\u524D\u4E00\u6761\u5B57\u5E55\u91CC
  - \u5B57\u5E55\u6574\u6BB5\u843D\u5728\u9759\u97F3\u91CC
  - \u6709\u58F0\u533A\u95F4\u6301\u7EED --min-uncovered \u79D2\u4EE5\u4E0A\u6CA1\u6709\u4EFB\u4F55\u5B57\u5E55\u8986\u76D6

\u53EA\u8FDB hints\uFF08\u4E0D\u5F71\u54CD\u9000\u51FA\u7801\uFF09\uFF1A
  - \u5B57\u5E55\u5728\u58F0\u97F3\u7ED3\u675F\u540E\u7EE7\u7EED\u505C\u7559\u8D85\u8FC7 --tolerance \u79D2\u3002\u7EC8\u7A3F\u5B57\u5E55\u6309\u53EF\u8BFB\u8BED\u4E49\u5355\u5143\u5EF6\u957F
    \u505C\u7559\u662F\u5141\u8BB8\u7684\uFF1B\u4F46\u5BF9 TTS \u6216\u5BF9\u9F50\u76F4\u63A5\u4EA7\u51FA\u7684\u65F6\u95F4\u6233\uFF0C\u8FD9\u8BF4\u660E\u5B83\u504F\u665A
  - \u5168\u90E8\u5B57\u5E55\u8D77\u70B9\u504F\u5DEE\u7684\u4E2D\u4F4D\u6570\u8D85\u8FC7\u5BB9\u5DEE\u7684\u4E00\u534A\uFF1A\u591A\u6761\u540C\u5411\u504F\u79FB\u8BF4\u660E\u65F6\u95F4\u6233\u6765\u6E90\u6709\u7CFB\u7EDF
    \u8BEF\u5DEE\uFF0C\u5E94\u6574\u4F53\u6821\u6B63\u800C\u4E0D\u662F\u9010\u6761\u4FEE

\u9010\u6761\u7684\u53D1\u58F0\u533A\u95F4\u4E0E\u504F\u5DEE\u5199\u5728 --report-json \u91CC\uFF0C\u5224\u65AD\u7ED3\u679C\u8BF7\u8BFB\u5B83\u3002`,
    example: `  # \u6821\u9A8C TTS \u4EA7\u51FA\u7684\u53E5\u7EA7\u65F6\u95F4\u6233
  am audio check --audio production/audio/voice.wav --srt production/audio/voice.srt

  # \u6821\u9A8C\u7EC8\u7A3F\u5B57\u5E55\u5E76\u7559\u5B58\u62A5\u544A
  am audio check --audio production/audio/voice.wav --srt transcription-production.srt \\
    --report-json production/audio/voice-check.json`,
    runE: () => {
      if (audioPath.value === "" || srtPath.value === "") throw new Error("\u5FC5\u987B\u540C\u65F6\u7ED9\u51FA --audio \u4E0E --srt");
      for (const [name, value] of [
        ["--tolerance", tolerance.value],
        ["--below-peak-db", belowPeakDB.value],
        ["--min-gap", minGap.value],
        ["--min-uncovered", minUncovered.value]
      ]) {
        if (!(value > 0) || !Number.isFinite(value)) throw new Error(`${name} \u5FC5\u987B\u662F\u6709\u9650\u6B63\u6570\uFF0C\u6536\u5230 ${formatG(value)}`);
      }
      const opts = { tolerance: tolerance.value, belowPeakDB: belowPeakDB.value, minGap: minGap.value, minUncovered: minUncovered.value };
      const cues = readCues(srtPath.value);
      const toolchain = newToolchain(currentEnvironment());
      const levels = toolchain.loudness(audioPath.value, Defaults2.window);
      const [speech2, threshold] = speech(levels, opts);
      const report = check2(cues, speech2, threshold, opts);
      if (reportPath.value !== "") writeReportJSON2(report, reportPath.value);
      stdout.write(`\u5B57\u5E55 ${cues.length} \u6761\uFF0C\u68C0\u6D4B\u5230\u53D1\u58F0 ${speech2.length} \u6BB5\uFF08\u9759\u97F3\u9608\u503C ${formatFixed(report.threshold_db, 1)} dBFS\uFF09
`);
      if (report.median_start_delta !== void 0) stdout.write(`\u5B57\u5E55\u8D77\u70B9\u76F8\u5BF9\u53D1\u58F0\u7684\u4E2D\u4F4D\u504F\u5DEE\uFF1A${signedFixed(report.median_start_delta, 3)} \u79D2
`);
      for (const hint of report.hints ?? []) stdout.write(`\u63D0\u793A\uFF1A${hint}
`);
      if (!report.ok) throw new Error(`\u5B57\u5E55\u65F6\u95F4\u8F74\u4E0E\u914D\u97F3\u4E0D\u7B26\uFF1A${srtPath.value}
  - ${(report.problems ?? []).join("\n  - ")}`);
      stdout.write("\u5B57\u5E55\u65F6\u95F4\u8F74\u4E0E\u914D\u97F3\u4E00\u81F4\n");
    }
  });
  const flags = cmd.flags();
  flags.stringVar(audioPath, "audio", "", "\u914D\u97F3\u6587\u4EF6\uFF0C\u5FC5\u586B");
  flags.stringVar(srtPath, "srt", "", "\u5F85\u6821\u9A8C\u7684\u5B57\u5E55\u6587\u4EF6\uFF0C\u5FC5\u586B");
  flags.stringVar(reportPath, "report-json", "", "\u628A\u9010\u6761\u6BD4\u5BF9\u7ED3\u679C\u5199\u6210 JSON \u62A5\u544A\u5230\u8BE5\u8DEF\u5F84");
  flags.float64Var(tolerance, "tolerance", Defaults2.tolerance, "\u5B57\u5E55\u8FB9\u754C\u4E0E\u53D1\u58F0\u8FB9\u754C\u5141\u8BB8\u7684\u504F\u5DEE\uFF08\u79D2\uFF09");
  flags.float64Var(belowPeakDB, "below-peak-db", Defaults2.belowPeakDB, "\u4F4E\u4E8E\u5168\u7247\u6700\u54CD\u5904\u591A\u5C11\u5206\u8D1D\u89C6\u4E3A\u9759\u97F3");
  flags.float64Var(minGap, "min-gap", Defaults2.minGap, "\u89C6\u4E3A\u505C\u987F\u7684\u6700\u77ED\u9759\u97F3\uFF08\u79D2\uFF09\uFF0C\u66F4\u77ED\u7684\u5E76\u5165\u53D1\u58F0");
  flags.float64Var(minUncovered, "min-uncovered", Defaults2.minUncovered, "\u62A5\u544A\u65E0\u5B57\u5E55\u8986\u76D6\u7684\u6700\u77ED\u53D1\u58F0\uFF08\u79D2\uFF09");
  return cmd;
}

// src/project_cmds.ts
var import_node_fs28 = __toESM(require("node:fs"), 1);
var import_node_path24 = __toESM(require("node:path"), 1);

// ../engine/src/archive/archive.ts
var import_node_child_process5 = require("node:child_process");
var import_node_crypto5 = __toESM(require("node:crypto"), 1);
var import_node_fs21 = __toESM(require("node:fs"), 1);
var import_node_path17 = __toESM(require("node:path"), 1);
function trimSpace(s) {
  let start = 0;
  let end = s.length;
  while (start < end && isGoSpace2(s.charCodeAt(start))) start++;
  while (end > start && isGoSpace2(s.charCodeAt(end - 1))) end--;
  return s.slice(start, end);
}
function isGoSpace2(c) {
  return c >= 9 && c <= 13 || c === 32 || c === 133 || c === 160 || c === 5760 || c >= 8192 && c <= 8202 || c === 8232 || c === 8233 || c === 8239 || c === 8287 || c === 12288;
}
var errnoText2 = {
  ENOENT: "no such file or directory",
  EACCES: "permission denied",
  EPERM: "operation not permitted",
  ENOTDIR: "not a directory",
  EISDIR: "is a directory",
  EEXIST: "file exists",
  ENOTEMPTY: "directory not empty",
  EXDEV: "cross-device link"
};
function reasonOf(err) {
  const code = err?.code;
  return code && errnoText2[code] || (err instanceof Error ? err.message : String(err));
}
function pathError2(op, file, err) {
  return new Error(`${op} ${file}: ${reasonOf(err)}`, { cause: err });
}
function gitPath() {
  return lookPath("git", process.env.PATH ?? "");
}
function gitOutput(root, ...args) {
  const result = (0, import_node_child_process5.spawnSync)(gitPath(), args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")}: ${trimSpace(result.stderr.toString("utf8"))}`);
  }
  return result.stdout;
}
function gitOutputOrEmpty(root, ...args) {
  try {
    return gitOutput(root, ...args);
  } catch {
    return Buffer.alloc(0);
  }
}
function splitNUL(body) {
  const result = [];
  let start = 0;
  for (let i = 0; i <= body.length; i++) {
    if (i === body.length || body[i] === 0) {
      if (i > start) {
        result.push(body.subarray(start, i).toString("utf8"));
      }
      start = i + 1;
    }
  }
  return result;
}
function existsAt(root, commit, file) {
  const result = (0, import_node_child_process5.spawnSync)(gitPath(), ["cat-file", "-e", commit + ":" + file], { cwd: root, stdio: "ignore" });
  return !result.error && result.status === 0;
}
function goBase(p) {
  if (p === "") return ".";
  let s = p;
  while (s.length > 0 && s.endsWith("/")) s = s.slice(0, -1);
  if (s === "") return "/";
  return s.slice(s.lastIndexOf("/") + 1);
}
var printable = /^[\p{L}\p{M}\p{N}\p{P}\p{S}]$/u;
function goQuote4(s) {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    switch (ch) {
      case '"':
        out += '\\"';
        continue;
      case "\\":
        out += "\\\\";
        continue;
      case "\x07":
        out += "\\a";
        continue;
      case "\b":
        out += "\\b";
        continue;
      case "\f":
        out += "\\f";
        continue;
      case "\n":
        out += "\\n";
        continue;
      case "\r":
        out += "\\r";
        continue;
      case "	":
        out += "\\t";
        continue;
      case "\v":
        out += "\\v";
        continue;
    }
    if (ch === " " || c >= 33 && c < 127 || c >= 128 && printable.test(ch)) {
      out += ch;
    } else if (c < 32 || c === 127) {
      out += "\\x" + c.toString(16).padStart(2, "0");
    } else if (c < 65536) {
      out += "\\u" + c.toString(16).padStart(4, "0");
    } else {
      out += "\\U" + c.toString(16).padStart(8, "0");
    }
  }
  return out + '"';
}
function buildPlan(root, mainRef, archiveRoot, name) {
  const top = gitOutput(root, "rev-parse", "--show-toplevel");
  root = trimSpace(top.toString("utf8"));
  const mainCommitRaw = gitOutput(root, "rev-parse", "--verify", mainRef + "^{commit}");
  const sourceCommitRaw = gitOutput(root, "rev-parse", "--verify", "HEAD");
  const sourceRefRaw = gitOutputOrEmpty(root, "branch", "--show-current");
  if (archiveRoot === "") {
    archiveRoot = import_node_path17.default.join(import_node_path17.default.dirname(root), "_archive");
  }
  if (!import_node_path17.default.isAbsolute(archiveRoot)) {
    archiveRoot = import_node_path17.default.join(root, archiveRoot);
  }
  archiveRoot = import_node_path17.default.resolve(archiveRoot);
  if (archiveRoot === root || archiveRoot.startsWith(root + import_node_path17.default.sep)) {
    throw new Error(`\u5F52\u6863\u76EE\u5F55\u4E0D\u5F97\u4F4D\u4E8E\u4ED3\u5E93\u5185\u90E8\uFF1A${archiveRoot}`);
  }
  if (name === "") {
    name = trimSpace(sourceRefRaw.toString("utf8")).replaceAll("/", "-");
    if (name === "") {
      name = "detached-project";
    }
  }
  if (name === "." || name === ".." || goBase(name) !== name || /[\r\n\x00]/.test(name)) {
    throw new Error(`\u5F52\u6863\u76EE\u5F55\u540D\u4E0D\u5F97\u5305\u542B\u8DEF\u5F84\u5206\u9694\u7B26\u6216\u63A7\u5236\u5B57\u7B26\uFF1A${goQuote4(name)}`);
  }
  const plan = {
    repository: root,
    mainRef,
    mainCommit: trimSpace(mainCommitRaw.toString("utf8")),
    sourceRef: trimSpace(sourceRefRaw.toString("utf8")),
    sourceCommit: trimSpace(sourceCommitRaw.toString("utf8")),
    destination: import_node_path17.default.join(archiveRoot, name),
    candidates: [],
    shared: [],
    ignored: []
  };
  const diff = gitOutput(root, "diff", "--name-status", "-z", plan.mainCommit, "--");
  const records = splitNUL(diff);
  for (let i = 0; i < records.length; ) {
    const status = records[i];
    i++;
    let count = 1;
    if (status.startsWith("R") || status.startsWith("C")) {
      count = 2;
    }
    for (let n = 0; n < count && i < records.length; n++, i++) {
      const file = records[i];
      if (existsAt(root, plan.mainCommit, file)) {
        plan.shared.push(file);
      } else if (lstatOrNull(import_node_path17.default.join(root, file)) !== null) {
        plan.candidates.push(file);
      }
    }
  }
  const untracked = gitOutputOrEmpty(root, "ls-files", "-z", "--others", "--exclude-standard");
  plan.candidates.push(...splitNUL(untracked));
  const ignored = gitOutputOrEmpty(root, "ls-files", "-z", "--others", "--ignored", "--exclude-standard");
  plan.ignored = splitNUL(ignored);
  plan.candidates = uniqueSorted(plan.candidates);
  plan.shared = uniqueSorted(plan.shared);
  plan.ignored = uniqueSorted(plan.ignored);
  return plan;
}
function lstatOrNull(target) {
  try {
    return import_node_fs21.default.lstatSync(target);
  } catch {
    return null;
  }
}
function uniqueSorted(values) {
  return [...new Set(values)].sort(compareBytes);
}
function execute2(plan) {
  if (plan.shared.length > 0) {
    throw new Error(`main \u5171\u4EAB\u6587\u4EF6\u6709\u4FEE\u6539\uFF0C\u62D2\u7EDD\u5F52\u6863\uFF1A${plan.shared.join(", ")}`);
  }
  if (plan.ignored.length > 0) {
    throw new Error(`\u5B58\u5728 ignored \u6587\u4EF6\uFF0C\u62D2\u7EDD\u5F52\u6863\uFF1A${plan.ignored.join(", ")}`);
  }
  let exists4 = true;
  try {
    import_node_fs21.default.statSync(plan.destination);
  } catch (err) {
    if (err.code === "ENOENT") exists4 = false;
  }
  if (exists4) {
    throw new Error(`\u5F52\u6863\u76EE\u6807\u5DF2\u5B58\u5728\uFF1A${plan.destination}`);
  }
  const payload = import_node_path17.default.join(plan.destination, "files");
  mkdirAll(payload);
  const moved = [];
  const rollback = () => {
    for (let i = moved.length - 1; i >= 0; i--) {
      const from = import_node_path17.default.join(payload, moved[i]);
      const to = import_node_path17.default.join(plan.repository, moved[i]);
      try {
        import_node_fs21.default.mkdirSync(import_node_path17.default.dirname(to), { recursive: true, mode: 493 });
      } catch {
      }
      try {
        import_node_fs21.default.renameSync(from, to);
      } catch {
      }
    }
    try {
      import_node_fs21.default.rmSync(plan.destination, { recursive: true, force: true });
    } catch {
    }
  };
  for (const relative of plan.candidates) {
    const from = import_node_path17.default.join(plan.repository, relative);
    const to = import_node_path17.default.join(payload, relative);
    try {
      mkdirAll(import_node_path17.default.dirname(to));
    } catch (err) {
      rollback();
      throw err;
    }
    try {
      import_node_fs21.default.renameSync(from, to);
    } catch (err) {
      rollback();
      throw new Error(`\u79FB\u52A8 ${relative}: rename ${from} ${to}: ${reasonOf(err)}`, { cause: err });
    }
    moved.push(relative);
  }
  const entries = [];
  for (const relative of moved) {
    const file = import_node_path17.default.join(payload, relative);
    let info;
    try {
      info = import_node_fs21.default.lstatSync(file);
    } catch (err) {
      rollback();
      throw pathError2("lstat", file, err);
    }
    const entry = { path: relative };
    if (info.isSymbolicLink()) {
      try {
        const target = import_node_fs21.default.readlinkSync(file);
        if (target !== "") entry.symlink_target = target;
      } catch {
      }
    } else {
      let body2;
      try {
        body2 = import_node_fs21.default.readFileSync(file);
      } catch (err) {
        rollback();
        throw pathError2(err && err.code === "EISDIR" ? "read" : "open", file, err);
      }
      entry.sha256 = import_node_crypto5.default.createHash("sha256").update(body2).digest("hex");
    }
    entries.push(entry);
  }
  const manifest = sortedKeys({
    schema_version: 1,
    source_ref: plan.sourceRef,
    source_commit: plan.sourceCommit,
    main_ref: plan.mainRef,
    main_commit: plan.mainCommit,
    moved_count: moved.length,
    files: entries.map((e) => ({ path: e.path, sha256: e.sha256, symlink_target: e.symlink_target }))
  });
  const body = marshalIndent(manifest);
  const manifestPath = import_node_path17.default.join(plan.destination, "MANIFEST.json");
  try {
    import_node_fs21.default.writeFileSync(manifestPath, body + "\n", { mode: 420 });
  } catch (err) {
    rollback();
    throw pathError2("open", manifestPath, err);
  }
  let git;
  try {
    git = gitPath();
  } catch (err) {
    rollback();
    throw err;
  }
  const result = (0, import_node_child_process5.spawnSync)(git, ["switch", "--detach", plan.mainCommit], {
    cwd: plan.repository,
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.error || result.status !== 0) {
    rollback();
    const output2 = Buffer.concat([result.stdout ?? Buffer.alloc(0), result.stderr ?? Buffer.alloc(0)]).toString("utf8");
    throw new Error(`\u590D\u4F4D\u5230 main \u5931\u8D25\uFF1A${trimSpace(output2)}`);
  }
}
function mkdirAll(dir) {
  try {
    import_node_fs21.default.mkdirSync(dir, { recursive: true, mode: 493 });
  } catch (err) {
    throw pathError2("mkdir", dir, err);
  }
}

// ../engine/src/config/config.ts
var import_node_fs22 = __toESM(require("node:fs"), 1);
var import_node_os3 = __toESM(require("node:os"), 1);
var import_node_path18 = __toESM(require("node:path"), 1);

// ../engine/src/tools/tools.ts
var ValidTools = /* @__PURE__ */ new Set(["codex", "claude", "qoder", "codebuddy", "opencode"]);

// ../engine/src/config/providers.ts
var TTSProviders = [
  { id: "minimax", name: "MiniMax\uFF08mmx CLI\uFF09", timestamps: "sentence", command: "mmx" },
  { id: "bailian", name: "\u963F\u91CC\u4E91\u767E\u70BC\uFF08bl CLI\uFF09", timestamps: "none", command: "bl" },
  { id: "edge", name: "\u5FAE\u8F6F Edge \u5728\u7EBF\u8BED\u97F3\uFF08edge-tts\uFF0C\u514D\u9274\u6743\uFF09", timestamps: "sentence", command: "edge-tts" },
  { id: "elevenlabs", name: "ElevenLabs\uFF08\u5B98\u65B9 CLI\uFF09", timestamps: "char", command: "elevenlabs" },
  { id: "tencent", name: "\u817E\u8BAF\u4E91\u8BED\u97F3\u5408\u6210\uFF08tccli\uFF09", timestamps: "sentence", command: "tccli" },
  { id: "mlx", name: "\u672C\u673A MLX \u8BED\u97F3\u5408\u6210\uFF08mlx-audio\uFF0C\u4EC5 Apple Silicon\uFF09", timestamps: "none", command: "mlx_audio.tts.generate" }
];
var Aligners = [
  { id: "mlx", name: "Qwen3-ForcedAligner\uFF08mlx-audio\uFF0CApple Silicon \u672C\u673A\uFF09", command: "mlx_audio.stt.generate" },
  { id: "funasr", name: "FunASR \u65F6\u95F4\u6233\u9884\u6D4B\uFF08CPU\uFF0CmacOS \u4E0E Linux\uFF09", command: "python3" }
];
var AlignAuto = "auto";
function resolveAligner(value, goos, goarch) {
  if (value !== AlignAuto) return value;
  if (goos === "darwin" && goarch === "arm64") return "mlx";
  return "funasr";
}
function validTTSProvider(id) {
  return TTSProviders.some((provider) => provider.id === id);
}
function validAligner(id) {
  return Aligners.some((aligner) => aligner.id === id);
}
function ttsProviderIDs() {
  return TTSProviders.map((provider) => provider.id).join(" ");
}
function alignerIDs() {
  return [AlignAuto, ...Aligners.map((aligner) => aligner.id)].join(" ");
}
function hostAligner(value) {
  return resolveAligner(value, process.platform, process.arch);
}
function goFields(value) {
  const out = [];
  let current = "";
  for (const ch of value) {
    if (isGoSpace(ch.codePointAt(0))) {
      if (current !== "") out.push(current);
      current = "";
    } else current += ch;
  }
  if (current !== "") out.push(current);
  return out;
}
var shellControl = /* @__PURE__ */ new Set([";", "&", "|", "`", "$", "<", ">", "(", ")", "\\", '"', "'", "*", "\n"]);
function parseAllowCommands(value) {
  const out = [];
  for (const raw of value.split(",")) {
    const item = goFields(raw).join(" ");
    if (item === "") continue;
    if ([...item].some((c) => shellControl.has(c))) {
      throw new Error(
        `ORCHESTRATOR_ALLOW_COMMANDS \u91CC\u7684 ${goQuote(item)} \u5E26\u4E86 shell \u63A7\u5236\u7B26\uFF1B\u53EA\u5199\u547D\u4EE4\u524D\u7F00\uFF0C\u4F8B\u5982 "uv run"\u3001"pnpm"\uFF0C\u591A\u4E2A\u7528\u9017\u53F7\u5206\u9694`
      );
    }
    out.push(item);
  }
  return out;
}

// ../engine/src/config/config.ts
var DefaultSceneJobs = 3;
var MaxSceneJobs = 16;
var secretKey = (() => {
  const longS = String.fromCodePoint(383);
  const kelvin = String.fromCodePoint(8490);
  const ci2 = (word2) => [...word2].map((c) => {
    const lower = c.toLowerCase();
    if (lower < "a" || lower > "z") return c;
    let cls = lower + lower.toUpperCase();
    if (lower === "s") cls += longS;
    if (lower === "k") cls += kelvin;
    return "[" + cls + "]";
  }).join("");
  return new RegExp("(" + ["API_KEY", "TOKEN", "SECRET", "PASSWORD"].map(ci2).join("|") + ")$");
})();
function newConfig(fields2 = {}) {
  return {
    orchestrator: "",
    renderer: "",
    ttsProvider: "",
    alignProvider: "",
    sceneJobs: 0,
    overlay: {},
    filmStyleRoot: "",
    hyperFramesCLI: "",
    extraCommands: [],
    ...fields2,
    memory: { enabled: false, dir: "", snapshot: 0, recallBudget: 0, explore: 0, ...fields2.memory }
  };
}
var DefaultMemoryRecallBudget = 1500;
var DefaultMemoryExplore = 0.1;
var MaxMemoryExplore = 0.5;
function defaultMemoryDir(environ) {
  const dir = environ.XDG_DATA_HOME;
  if (dir) return import_node_path18.default.join(dir, "am", "memory");
  let home = environ.HOME ?? "";
  if (home === "") home = import_node_os3.default.homedir();
  return import_node_path18.default.join(home, ".local", "share", "am", "memory");
}
function parseFile(file) {
  const out = {};
  let body;
  try {
    body = import_node_fs22.default.readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return out;
    throw new Error(goPathError("open", file, err), { cause: err });
  }
  const lines = body.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  for (const raw of lines) {
    let line2 = goTrimSpace(raw.endsWith("\r") ? raw.slice(0, -1) : raw);
    if (line2 === "" || line2.startsWith("#")) continue;
    if (line2.startsWith("export ")) line2 = line2.slice("export ".length);
    const eq = line2.indexOf("=");
    if (eq < 0) continue;
    const key = goTrimSpace(line2.slice(0, eq));
    let value = goTrimSpace(line2.slice(eq + 1));
    if (value.length >= 2 && (value[0] === "'" && value.endsWith("'") || value[0] === '"' && value.endsWith('"'))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}
function goAtoi(value) {
  if (!/^[+-]?[0-9]+$/.test(value)) return void 0;
  const big = BigInt(value);
  if (big > 9223372036854775807n || big < -9223372036854775808n) return void 0;
  return Number(big);
}
function goParseFloat2(value) {
  const special = /^([+-]?)(inf|infinity|nan)$/i.exec(value);
  if (special) {
    if (special[2].toLowerCase() === "nan") return special[1] === "" ? NaN : void 0;
    return special[1] === "-" ? -Infinity : Infinity;
  }
  if (!/^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?$/.test(value)) return void 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : void 0;
}
function formatFloatShortest(value) {
  if (Number.isNaN(value)) return "NaN";
  if (!Number.isFinite(value)) return value > 0 ? "+Inf" : "-Inf";
  const negative = value < 0 || Object.is(value, -0);
  const [mantissa, expText] = Math.abs(value).toExponential().split("e");
  const digits = mantissa.replace(".", "");
  const exp = Number(expText);
  let out;
  if (exp >= digits.length - 1) out = digits + "0".repeat(exp - (digits.length - 1));
  else if (exp >= 0) out = digits.slice(0, exp + 1) + "." + digits.slice(exp + 1);
  else out = "0." + "0".repeat(-exp - 1) + digits;
  return (negative ? "-" : "") + out;
}
function load(root, environ) {
  const env = environ ?? envMap();
  let dotenv;
  try {
    dotenv = parseFile(import_node_path18.default.join(root, ".env"));
  } catch (err) {
    throw new Error(`\u8BFB\u53D6 .env: ${err.message}`, { cause: err });
  }
  for (const key of Object.keys(dotenv)) {
    if (secretKey.test(key)) throw new Error(`.env \u4E0D\u5F97\u4FDD\u5B58\u5BC6\u94A5 ${key}\uFF0C\u8BF7\u4F7F\u7528\u5BF9\u5E94\u5DE5\u5177\u7684\u767B\u5F55\u547D\u4EE4`);
  }
  let conf;
  try {
    conf = parseFile(import_node_path18.default.join(root, "article-to-motion.conf"));
  } catch (err) {
    throw new Error(`\u8BFB\u53D6 article-to-motion.conf: ${err.message}`, { cause: err });
  }
  const resolve3 = (key, fallback) => {
    for (const source of [env, dotenv, conf]) {
      const value = source[key];
      if (value) return value;
    }
    return fallback;
  };
  const cfg = newConfig({
    orchestrator: resolve3("ORCHESTRATOR", ""),
    renderer: resolve3("RENDERER", ""),
    ttsProvider: resolve3("TTS_PROVIDER", "minimax"),
    overlay: dotenv
  });
  if (!ValidTools.has(cfg.orchestrator)) {
    throw new Error(`\u65E0\u6548\u7684 ORCHESTRATOR: ${cfg.orchestrator}\uFF08\u53EF\u9009\uFF1Acodex claude qoder codebuddy opencode\uFF09`);
  }
  if (!ValidTools.has(cfg.renderer)) {
    throw new Error(`\u65E0\u6548\u7684 RENDERER: ${cfg.renderer}\uFF08\u53EF\u9009\uFF1Acodex claude qoder codebuddy opencode\uFF09`);
  }
  if (!validTTSProvider(cfg.ttsProvider)) {
    throw new Error(`\u65E0\u6548\u7684 TTS_PROVIDER: ${cfg.ttsProvider}\uFF08\u53EF\u9009\uFF1A${ttsProviderIDs()}\uFF09`);
  }
  const align = resolve3("ALIGN_PROVIDER", AlignAuto);
  if (align !== AlignAuto && !validAligner(align)) {
    throw new Error(`\u65E0\u6548\u7684 ALIGN_PROVIDER: ${align}\uFF08\u53EF\u9009\uFF1A${alignerIDs()}\uFF09`);
  }
  cfg.alignProvider = hostAligner(align);
  const jobs = goAtoi(resolve3("SCENE_JOBS", String(DefaultSceneJobs)));
  if (jobs === void 0 || jobs < 1 || jobs > MaxSceneJobs) throw new Error(`SCENE_JOBS \u5FC5\u987B\u5728 1..${MaxSceneJobs} \u4E4B\u95F4`);
  cfg.sceneJobs = jobs;
  const memory = resolve3("MEMORY", "on").toLowerCase();
  if (memory === "on") cfg.memory.enabled = true;
  else if (memory !== "off") throw new Error(`\u65E0\u6548\u7684 MEMORY: ${memory}\uFF08\u53EF\u9009\uFF1Aon off\uFF09`);
  cfg.extraCommands = parseAllowCommands(resolve3("ORCHESTRATOR_ALLOW_COMMANDS", ""));
  cfg.memory.dir = resolve3("AM_MEMORY_DIR", defaultMemoryDir(env));
  cfg.filmStyleRoot = resolve3(RootEnv, rootDir(env));
  cfg.hyperFramesCLI = resolve3(CLIDirEnv, cliDir(env, PinnedVersion));
  const snapshotText = resolve3("MEMORY_SNAPSHOT", "");
  if (snapshotText !== "") {
    const snapshot = goAtoi(snapshotText);
    if (snapshot === void 0 || snapshot < 1) throw new Error("MEMORY_SNAPSHOT \u5FC5\u987B\u662F\u6B63\u6574\u6570\u5FEB\u7167\u53F7\uFF0C\u7559\u7A7A\u8868\u793A\u8DDF\u968F\u6700\u65B0\u5FEB\u7167");
    cfg.memory.snapshot = snapshot;
  }
  const budget = goAtoi(resolve3("MEMORY_RECALL_BUDGET", String(DefaultMemoryRecallBudget)));
  if (budget === void 0 || budget < 0) throw new Error("MEMORY_RECALL_BUDGET \u5FC5\u987B\u662F\u975E\u8D1F\u6574\u6570");
  cfg.memory.recallBudget = budget;
  const explore = goParseFloat2(resolve3("MEMORY_EXPLORE", formatFloatShortest(DefaultMemoryExplore)));
  if (explore === void 0 || explore < 0 || explore > MaxMemoryExplore) {
    throw new Error(`MEMORY_EXPLORE \u5FC5\u987B\u662F 0 \u5230 ${formatG(MaxMemoryExplore)} \u4E4B\u95F4\u7684\u5C0F\u6570\uFF080 \u5173\u95ED\u63A2\u7D22\uFF09`);
  }
  cfg.memory.explore = explore;
  return cfg;
}

// ../engine/src/projectinit/index.ts
var import_node_fs27 = __toESM(require("node:fs"), 1);
var import_node_path23 = __toESM(require("node:path"), 1);

// ../engine/src/assets/index.ts
var import_node_fs23 = __toESM(require("node:fs"), 1);
var import_node_path19 = __toESM(require("node:path"), 1);
var explicitDotEntries = /* @__PURE__ */ new Set(["assets/shared/.env.example", "assets/shared/.agents"]);
var cachedRoot;
function assetsBase() {
  if (cachedRoot) return cachedRoot;
  const explicit = process.env.AM_ASSETS_DIR;
  if (explicit) {
    cachedRoot = import_node_path19.default.dirname(import_node_path19.default.resolve(explicit));
    return cachedRoot;
  }
  const starts = [typeof __dirname === "string" ? __dirname : "", process.cwd()].filter(Boolean);
  for (const start of starts) {
    let dir = import_node_path19.default.resolve(start);
    for (; ; ) {
      if (import_node_fs23.default.existsSync(import_node_path19.default.join(dir, "assets", "shared", "PROMPT.md"))) {
        cachedRoot = dir;
        return dir;
      }
      const parent = import_node_path19.default.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  throw new Error("\u627E\u4E0D\u5230 am \u81EA\u5E26\u7684 assets \u76EE\u5F55\uFF1A\u8BF7\u8BBE\u7F6E AM_ASSETS_DIR");
}
var AssetTree = class _AssetTree {
  constructor(dir, embedPath) {
    this.dir = dir;
    this.embedPath = embedPath;
  }
  dir;
  embedPath;
  abs(rel) {
    const clean = import_node_path19.default.posix.normalize(rel).replace(/^\/+/, "");
    if (clean === ".." || clean.startsWith("../")) throw new Error(`\u8D44\u4EA7\u8DEF\u5F84\u8D8A\u754C\uFF1A${rel}`);
    return import_node_path19.default.join(this.dir, clean);
  }
  readFile(rel) {
    return import_node_fs23.default.readFileSync(this.abs(rel));
  }
  readText(rel) {
    return import_node_fs23.default.readFileSync(this.abs(rel), "utf8");
  }
  exists(rel) {
    return import_node_fs23.default.existsSync(this.abs(rel));
  }
  /** 子树，对应 fs.Sub。 */
  sub(rel) {
    return new _AssetTree(this.abs(rel), import_node_path19.default.posix.join(this.embedPath, rel));
  }
  /** 目录下的直接条目（已按 go:embed 规则过滤），按名字排序。 */
  readDir(rel = ".") {
    const embedDir = import_node_path19.default.posix.join(this.embedPath, rel);
    return import_node_fs23.default.readdirSync(this.abs(rel), { withFileTypes: true }).filter((entry) => included(embedDir, entry.name)).map((entry) => ({ name: entry.name, isDir: entry.isDirectory() })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  }
  /** 递归列出全部文件（相对树根，/ 分隔，按 fs.WalkDir 的词法顺序），对应 fs.WalkDir 只取文件。 */
  walkFiles() {
    const out = [];
    const visit = (rel) => {
      for (const entry of this.readDir(rel)) {
        const child = rel === "." ? entry.name : `${rel}/${entry.name}`;
        if (entry.isDir) visit(child);
        else out.push(child);
      }
    };
    visit(".");
    return out;
  }
};
function included(embedDir, name) {
  if (!name.startsWith(".") && !name.startsWith("_")) return true;
  return explicitDotEntries.has(import_node_path19.default.posix.join(embedDir, name));
}
function tree(rel) {
  return new AssetTree(import_node_path19.default.join(assetsBase(), rel), rel);
}
function shared() {
  return tree("assets/shared");
}
function preset(id) {
  const sub = tree(`assets/presets/${id}`);
  if (!import_node_fs23.default.existsSync(sub.dir)) throw new Error(`\u627E\u4E0D\u5230\u9884\u8BBE\u7D20\u6750 ${id}: open assets/presets/${id}: file does not exist`);
  if (!sub.exists("PROMPT-PRODUCTION.md")) throw new Error(`\u9884\u8BBE\u7D20\u6750 ${id} \u4E0D\u5B8C\u6574\uFF0C\u7F3A\u5C11 PROMPT-PRODUCTION.md`);
  return sub;
}
function style2(styleID, canvasID) {
  const sub = tree(`assets/styles/${styleID}/${canvasID}`);
  if (!import_node_fs23.default.existsSync(sub.dir)) throw new Error(`\u627E\u4E0D\u5230\u98CE\u683C\u7D20\u6750 ${styleID}/${canvasID}: open assets/styles/${styleID}/${canvasID}: file does not exist`);
  if (!sub.exists("frame.md")) throw new Error(`\u98CE\u683C\u7D20\u6750 ${styleID}/${canvasID} \u4E0D\u5B8C\u6574\uFF0C\u7F3A\u5C11 frame.md`);
  return sub;
}
function builtinSkills() {
  const out = /* @__PURE__ */ new Set();
  for (const entry of shared().readDir(".agents/skills")) if (entry.isDir) out.add(entry.name);
  if (out.size === 0) throw new Error("\u5185\u7F6E\u6280\u80FD\u6811\u662F\u7A7A\u7684\uFF1Aassets/shared/.agents/skills");
  return out;
}
var FontsDir = "assets/fonts/";
function fontFiles(fonts) {
  const out = /* @__PURE__ */ new Map();
  const pool = tree("assets/fontpool");
  for (const font2 of fonts) {
    for (const name of [font2.file, font2.license]) {
      if (out.has(FontsDir + name)) continue;
      if (!pool.exists(name)) throw new Error(`\u5B57\u4F53\u6C60\u91CC\u6CA1\u6709\u6587\u4EF6 ${name}`);
      out.set(FontsDir + name, pool.readFile(name));
    }
  }
  return out;
}
function styleFonts(style3) {
  try {
    return fontFiles(style3.fonts);
  } catch (err) {
    throw new Error(`\u98CE\u683C ${style3.id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ../engine/src/cast/yamldecode.ts
var import_yaml2 = __toESM(require_dist(), 1);

// ../engine/src/cast/pack.ts
var SchemaVersion = "cast/v1";

// ../engine/src/styleimage/styleimage.ts
var quantizeThreshold = 400 * 1024;

// ../engine/src/cast/roster.ts
var import_node_fs24 = __toESM(require("node:fs"), 1);
var import_node_path20 = __toESM(require("node:path"), 1);
var RosterFile = "cast.yaml";
function hasRoster(root) {
  try {
    return !import_node_fs24.default.statSync(import_node_path20.default.join(root, RosterFile)).isDirectory();
  } catch {
    return false;
  }
}

// ../engine/src/project/init.ts
var import_node_crypto6 = __toESM(require("node:crypto"), 1);
var import_node_fs25 = __toESM(require("node:fs"), 1);
var import_node_path21 = __toESM(require("node:path"), 1);
function errText(err) {
  return err instanceof Error ? err.message : String(err);
}
function isNotExist2(err) {
  return err?.code === "ENOENT";
}
function validPath(name) {
  if (name === ".") return true;
  if (name === "") return false;
  for (const elem of name.split("/")) {
    if (elem === "" || elem === "." || elem === "..") return false;
  }
  return true;
}
function initializeWithFiles(target, extra, ...sources2) {
  target = import_node_path21.default.resolve(target);
  try {
    import_node_fs25.default.mkdirSync(target, { recursive: true, mode: 493 });
  } catch (err) {
    throw new Error(`\u521B\u5EFA\u9879\u76EE\u76EE\u5F55: ${goPathError("mkdir", target, err)}`, { cause: err });
  }
  const assets = [];
  const seen = /* @__PURE__ */ new Set();
  const extraEntries = extra instanceof Map ? [...extra.entries()] : Object.entries(extra ?? {});
  for (const [name, body] of extraEntries) {
    if (!validPath(name)) throw new Error(`\u65E0\u6548\u6A21\u677F\u8DEF\u5F84\uFF1A${name}`);
    assets.push({ name, body: Buffer.from(body) });
    seen.add(name);
  }
  for (const source of sources2) {
    try {
      for (const file of source.walkFiles()) {
        if (seen.has(file)) throw new Error(`\u591A\u68F5\u6E90\u6811\u5199\u5165\u540C\u4E00\u8DEF\u5F84\uFF1A${file}`);
        seen.add(file);
        assets.push({ name: file, body: source.readFile(file) });
      }
    } catch (err) {
      throw new Error(`\u8BFB\u53D6\u5185\u7F6E\u9879\u76EE\u6A21\u677F: ${errText(err)}`, { cause: err });
    }
  }
  const result = { created: 0, unchanged: 0 };
  for (const item of assets) {
    const destination = import_node_path21.default.join(target, ...item.name.split("/"));
    rejectSymlinkPath(target, destination);
    let existing = null;
    try {
      existing = import_node_fs25.default.readFileSync(destination);
    } catch (err) {
      if (!isNotExist2(err)) {
        const op = err.code === "EISDIR" ? "read" : "open";
        throw new Error(`\u68C0\u67E5\u76EE\u6807\u6587\u4EF6 ${destination}: ${goPathError(op, destination, err)}`, { cause: err });
      }
    }
    if (existing !== null) {
      if (!existing.equals(item.body)) throw new Error(`\u76EE\u6807\u6587\u4EF6\u5DF2\u5B58\u5728\u4E14\u5185\u5BB9\u4E0D\u540C\uFF1A${destination}`);
      result.unchanged++;
    }
  }
  const created = [];
  const rollback = () => {
    for (let i = created.length - 1; i >= 0; i--) {
      try {
        import_node_fs25.default.rmSync(created[i], { force: true });
      } catch {
      }
    }
  };
  for (const item of assets) {
    const destination = import_node_path21.default.join(target, ...item.name.split("/"));
    if (import_node_fs25.default.existsSync(destination)) continue;
    try {
      import_node_fs25.default.mkdirSync(import_node_path21.default.dirname(destination), { recursive: true, mode: 493 });
    } catch (err) {
      rollback();
      throw new Error(goPathError("mkdir", import_node_path21.default.dirname(destination), err), { cause: err });
    }
    const tmpName = import_node_path21.default.join(import_node_path21.default.dirname(destination), `.am-init-${import_node_crypto6.default.randomBytes(5).readUInt32BE(0)}`);
    try {
      import_node_fs25.default.writeFileSync(tmpName, item.body, { mode: 384, flag: "wx" });
      import_node_fs25.default.chmodSync(tmpName, 420);
      import_node_fs25.default.renameSync(tmpName, destination);
    } catch (err) {
      try {
        import_node_fs25.default.rmSync(tmpName, { force: true });
      } catch {
      }
      rollback();
      throw new Error(`\u5199\u5165 ${destination}: ${errText(err)}`, { cause: err });
    }
    created.push(destination);
    result.created++;
  }
  return result;
}
function rejectSymlinkPath(root, destination) {
  const relative = import_node_path21.default.relative(root, destination);
  if (relative === ".." || import_node_path21.default.isAbsolute(relative)) {
    throw new Error(`\u6A21\u677F\u8DEF\u5F84\u9003\u51FA\u9879\u76EE\u76EE\u5F55\uFF1A${destination}`);
  }
  let current = root;
  for (const part of relative.split(import_node_path21.default.sep)) {
    current = import_node_path21.default.join(current, part);
    let info;
    try {
      info = import_node_fs25.default.lstatSync(current);
    } catch (err) {
      if (isNotExist2(err)) return;
      throw new Error(`\u68C0\u67E5\u6A21\u677F\u8DEF\u5F84 ${current}: ${goPathError("lstat", current, err)}`, { cause: err });
    }
    if (info.isSymbolicLink()) throw new Error(`\u6A21\u677F\u8DEF\u5F84\u4E0D\u5F97\u5305\u542B\u7B26\u53F7\u94FE\u63A5\uFF1A${current}`);
    if (current !== destination && !info.isDirectory()) throw new Error(`\u6A21\u677F\u7236\u8DEF\u5F84\u4E0D\u662F\u76EE\u5F55\uFF1A${current}`);
  }
}

// ../engine/src/song/platforms.ts
var import_yaml4 = __toESM(require_dist(), 1);

// ../engine/src/song/store.ts
var import_node_fs26 = __toESM(require("node:fs"), 1);
var import_node_path22 = __toESM(require("node:path"), 1);
var import_yaml3 = __toESM(require_dist(), 1);
var Store2 = "production/song";
var DefaultConfig2 = `schema: 1
provider: minimax
lyrics: lyrics.txt
style: "Mandarin educational solo rap, clear diction"
language: zh
target_seconds: 120
bpm: 100
# Run am song providers for platform access and API key setup.
# Run am song configure --provider bailian|elevenlabs|fal|minimax|acestep|mureka|lyria|manual.
# endpoint: https://your-acestep-server.example
python: python3
`;
function statOK(file) {
  try {
    import_node_fs26.default.statSync(file);
    return true;
  } catch {
    return false;
  }
}
function enabled2(root) {
  return statOK(import_node_path22.default.join(root, "song.yaml"));
}

// ../engine/src/song/platforms.ts
function platform(id, name, model, key, console2, docs, notes) {
  return { id, name, model, key, console: console2, docs, notes };
}
var Platforms = [
  platform("manual", "\u7F51\u9875\u624B\u52A8\u751F\u6210 / \u5BFC\u5165\u6B4C\u66F2", "external", "", "\u7531\u7528\u6237\u9009\u62E9\u6B4C\u66F2\u751F\u6210\u7F51\u9875", "am song handoff --help", "\u65E0\u9700 API Key\uFF1B\u8F93\u51FA\u6B4C\u8BCD\u548C\u66F2\u98CE\u8BF4\u660E\u540E\u6682\u505C\uFF0C\u7528\u6237\u5728\u7F51\u9875\u751F\u6210\u5E76\u63D0\u4F9B\u97F3\u9891\uFF0C\u518D\u8FD0\u884C am song receive AUDIO\u3002"),
  platform("mureka", "Mureka \u5B98\u65B9 API", "mureka-9.5", "MUREKA_API_KEY", "https://platform.mureka.ai/", "https://platform.mureka.ai/docs/en/quickstart.html", "\u652F\u6301\u4E2D\u6587\u53CA\u81EA\u5E26\u6B4C\u8BCD\uFF1BAPI \u5355\u72EC\u5145\u503C\uFF0C\u4E0E\u7F51\u9875\u4F1A\u5458\u4E0D\u4E92\u901A\u3002\u6BCF\u6B21\u8BF7\u6C42\u4E00\u9996\uFF0C\u6309\u4EFB\u52A1 ID \u7EED\u8DD1\uFF1B\u65F6\u957F/BPM \u4EC5\u4F5C\u4E3A\u521B\u4F5C\u63D0\u793A\u3002"),
  platform("lyria", "Google Lyria", "lyria-3.5", "GEMINI_API_KEY", "https://aistudio.google.com/api-keys", "https://ai.google.dev/gemini-api/docs/music-generation", "\u9700 Gemini API \u9879\u76EE\u53CA\u5BF9\u5E94\u6A21\u578B\u6743\u9650/\u8BA1\u8D39\uFF1B\u4F7F\u7528 Interactions API \u6307\u5B9A\u6B4C\u8BCD\u3002\u76EE\u6807\u65F6\u957F\u4E0E BPM \u662F\u63D0\u793A\uFF0C\u9700\u8BD5\u542C\u6838\u5BF9\u662F\u5426\u6539\u8BCD\uFF1B\u540C\u6B65\u8BF7\u6C42\u4E2D\u65AD\u4E0D\u81EA\u52A8\u91CD\u53D1\u3002"),
  platform("bailian", "\u963F\u91CC\u4E91\u767E\u70BC Fun-Music", "fun-music-v1", "DASHSCOPE_API_KEY", "https://bailian.console.aliyun.com/", "https://help.aliyun.com/zh/model-studio/fun-music-api", "\u9700\u5317\u4EAC\u5730\u57DF Fun-Music \u9080\u6D4B\u6743\u9650\u53CA\u666E\u901A\u6309\u91CF API Key\uFF1B\u5F53\u524D Token Plan \u6E05\u5355\u672A\u5305\u542B\u97F3\u4E50\u3002\u6307\u5B9A\u6B4C\u8BCD\u65F6\u66F2\u98CE\u63D0\u793A\u88AB\u5FFD\u7565\uFF0C\u65F6\u957F/BPM \u4E0D\u4F5C\u4E3A API \u63A7\u5236\u53C2\u6570\u3002"),
  platform("elevenlabs", "ElevenLabs Music", "music_v2_5", "ELEVENLABS_API_KEY", "https://elevenlabs.io/app/developers/api-keys", "https://elevenlabs.io/docs/api-reference/music/compose", "\u9700\u6709 Music API \u6743\u9650\u53CA\u53EF\u7528\u4ED8\u8D39\u989D\u5EA6\uFF1B\u4F7F\u7528\u56FA\u5B9A\u6B4C\u8BCD composition_plan\uFF0C\u66F2\u98CE\u5EFA\u8BAE\u7528\u82F1\u6587\u3002"),
  platform("fal", "fal \u6258\u7BA1 ACE-Step", "fal-ai/ace-step", "FAL_KEY", "https://fal.ai/dashboard/keys", "https://fal.ai/models/fal-ai/ace-step/api", "\u65E0\u9700\u81EA\u5EFA\u670D\u52A1\u5668\uFF1B\u4F7F\u7528 fal \u961F\u5217\u534F\u8BAE\uFF0C\u4E0D\u80FD\u586B\u5230\u81EA\u5EFA ACE-Step endpoint\uFF1B\u4E0D\u5BA3\u79F0\u8BE5\u6A21\u578B\u4E3A ACE-Step 1.5\u3002"),
  platform("minimax", "MiniMax\uFF08mmx\uFF09", "music-3.0", "", "https://www.minimax.io/audio", "https://platform.minimax.io/docs/api-reference/music-generation", "\u590D\u7528 mmx \u767B\u5F55\uFF1B\u5DF2\u5B9E\u6D4B\u90E8\u5206\u8D26\u6237\u8FD4\u56DE HTTP 410\uFF08\u97F3\u4E50 API \u4E0D\u518D\u5411\u65B0\u7528\u6237\u5F00\u653E\uFF09\u3002\u767B\u5F55\u6210\u529F\u4E0D\u7B49\u4E8E\u97F3\u4E50\u6743\u9650\u53EF\u7528\u3002"),
  platform("acestep", "\u81EA\u5EFA/\u8FDC\u7AEF ACE-Step", "acestep-v15-turbo", "ACESTEP_API_KEY", "https://github.com/ace-step/ACE-Step-1.5", "https://github.com/ace-step/ACE-Step-1.5/blob/main/docs/en/API.md", "\u5FC5\u987B\u5DF2\u6709\u53EF\u8BBF\u95EE\u670D\u52A1\u5730\u5740\uFF1B\u5BC6\u94A5\u6309\u670D\u52A1\u8BBE\u7F6E\uFF0C\u53EF\u4E3A\u7A7A\u3002\u4E0D\u81EA\u52A8\u90E8\u7F72\u6A21\u578B\u3002")
];
var emptyPlatform = platform("", "", "", "", "", "", "");

// ../engine/src/song/download.ts
var downloadLimit = 512 << 20;

// ../engine/src/song/clock.ts
var startNs = process.hrtime.bigint();
var startMs = BigInt(Date.now());

// ../engine/src/song/diagnostic.ts
function ci(literal) {
  let out = "";
  for (const c of literal) {
    const lower = c.toLowerCase();
    if (lower >= "a" && lower <= "z") {
      let cls = lower + lower.toUpperCase();
      if (lower === "s") cls += String.fromCodePoint(383);
      if (lower === "k") cls += String.fromCodePoint(8490);
      out += "[" + cls + "]";
    } else {
      out += c;
    }
  }
  return out;
}
var S = "\\t\\n\\f\\r ";
var diagnosticRedactions = [
  // (?i)https?://[^\s<>"']+
  new RegExp(`${ci("http")}${ci("s")}?://[^${S}<>"']+`, "g"),
  // (?i)\b(?:bearer|basic)\s+[^\s,;"']+
  new RegExp(`\\b(?:${ci("bearer")}|${ci("basic")})[${S}]+[^${S},;"']+`, "g"),
  // (?i)\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password)\s*[=:]\s*[^\s,;]+
  new RegExp(
    `\\b(?:${ci("api")}[_-]?${ci("key")}|${ci("access")}[_-]?${ci("token")}|${ci("refresh")}[_-]?${ci("token")}|${ci("token")}|${ci("secret")}|${ci("password")})[${S}]*[=:][${S}]*[^${S},;]+`,
    "g"
  ),
  /\bsk-[A-Za-z0-9_-]+/g,
  /[A-Za-z0-9_./+=-]{32,}/g
];

// ../engine/src/song/handoff.ts
var handoffState = Store2 + "/web-handoff.json";

// ../engine/src/song/hosted.ts
var hanPattern = new RegExp("\\p{Script=Han}", "u");

// ../engine/src/projectinit/index.ts
var DeliverySpeech = "speech";
var DeliverySong = "song";
var DeliveryBeat = "beat";
var NarrationSolo = "solo";
var NarrationCast = "cast";
var CastDefaultGroundY = 0.78;
var CastDefaultGapMs = { turn: 240, interject: 100 };
function validate(opts) {
  if (opts.narration !== NarrationSolo && opts.narration !== NarrationCast) {
    throw new Error(`\u65E0\u6548\u7684\u53D9\u4E8B\u6A21\u5F0F\uFF1A${opts.narration}\uFF08\u53EF\u9009\uFF1A${NarrationSolo} ${NarrationCast}\uFF09`);
  }
  if (![DeliverySpeech, DeliverySong, DeliveryBeat].includes(opts.delivery)) {
    throw new Error(`\u8BB2\u89E3\u5F62\u5F0F\u5FC5\u987B\u4E3A ${DeliverySpeech}\u3001${DeliverySong} \u6216 ${DeliveryBeat}`);
  }
  const target = opts.target;
  if (opts.delivery === DeliveryBeat && (opts.narration === NarrationCast || hasRoster(target) || enabled2(target))) {
    throw new Error("\u5361\u70B9\u6A21\u5F0F\u4E0D\u80FD\u4E0E\u6B4C\u66F2\u8BB2\u89E3\u6216\u591A\u89D2\u8272\u5BF9\u8BDD\u540C\u65F6\u542F\u7528");
  }
  if (opts.delivery === DeliverySong && (opts.narration === NarrationCast || hasRoster(target)) || opts.narration === NarrationCast && enabled2(target)) {
    throw new Error("\u9996\u7248\u4E0D\u652F\u6301 song + cast");
  }
}
var bytes = (body) => typeof body === "string" ? Buffer.from(body) : body;
function create(opts) {
  validate(opts);
  const shared2 = shared();
  const presetFiles = preset(opts.canvas);
  const styleFiles = style2(opts.style.id, opts.canvas);
  const extra = new Map(styleFonts(opts.style));
  for (const [file, body] of Object.entries(opts.extra ?? {})) extra.set(file, bytes(body));
  if (opts.delivery === DeliverySong) extra.set("song.yaml", Buffer.from(DefaultConfig2));
  else if (opts.delivery === DeliveryBeat) extra.set(ConfigFile, Buffer.from(DefaultConfig));
  const result = initializeWithFiles(opts.target, extra, shared2, presetFiles, styleFiles);
  if (opts.narration === NarrationCast) {
    try {
      writeCastScaffold(opts.target);
    } catch (err) {
      throw new Error(`\u9879\u76EE\u6587\u4EF6\u5DF2\u5199\u5165\uFF0C\u4F46\u5199\u51FA ${RosterFile} \u5931\u8D25\uFF1A${err.message}`, { cause: err });
    }
  }
  return result;
}
function installSkills(target, env, output2, progress, signal) {
  return install(
    {
      projectDir: target,
      version: PinnedVersion,
      env,
      protectedSkills: builtinSkills(),
      output: output2,
      progress,
      cacheDir: defaultCacheDir(env),
      cacheOnly: true
    },
    signal
  );
}
function castYAML() {
  return `schema: ${SchemaVersion}
packs: []
defaults:
    ground_y: ${formatG(CastDefaultGroundY)}
    gap_ms:
        turn: ${CastDefaultGapMs.turn}
        interject: ${CastDefaultGapMs.interject}
`;
}
function writeCastScaffold(target) {
  try {
    import_node_fs27.default.mkdirSync(import_node_path23.default.join(target, "cast"), { recursive: true, mode: 493 });
  } catch (err) {
    throw new Error(`\u521B\u5EFA ${RosterFile} \u76EE\u5F55\u5931\u8D25\uFF1A${goPathError("mkdir", import_node_path23.default.join(target, "cast"), err)}`);
  }
  const rosterPath = import_node_path23.default.join(target, RosterFile);
  const body = castYAML();
  let existing;
  try {
    existing = import_node_fs27.default.readFileSync(rosterPath, "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") throw new Error(`\u68C0\u67E5 ${rosterPath} \u5931\u8D25\uFF1A${goPathError("open", rosterPath, err)}`);
  }
  if (existing !== void 0) {
    if (existing !== body) throw new Error(`\u76EE\u6807\u6587\u4EF6\u5DF2\u5B58\u5728\u4E14\u5185\u5BB9\u4E0D\u540C\uFF1A${rosterPath}`);
    return;
  }
  try {
    atomicWrite(rosterPath, body, 420);
  } catch (err) {
    throw new Error(`\u5199\u5165 ${rosterPath} \u5931\u8D25\uFF1A${err.message}`);
  }
}

// src/project_cmds.ts
var narrationSolo = NarrationSolo;
var narrationCast = NarrationCast;
function newInitCommand(stdout, stderr) {
  const skipHyperframes = ref(false);
  const canvasID = ref("");
  const styleID = ref("");
  const styleBrief = ref("");
  const styleBriefFile = ref("");
  const narration = ref("");
  const delivery = ref("");
  const filmStyleName = ref("");
  const initCmd = new Command({
    use: "init [DIR]",
    short: "\u521D\u59CB\u5316\u4E00\u4E2A\u53EF\u590D\u73B0\u7684\u89C6\u9891\u9879\u76EE",
    long: `\u5728 DIR\uFF08\u7701\u7565\u5219\u4E3A\u5F53\u524D\u76EE\u5F55\uFF09\u5199\u5165\u89C6\u9891\u9879\u76EE\u9AA8\u67B6\u3002

\u753B\u5E45\u5728\u521D\u59CB\u5316\u65F6\u4E00\u6B21\u6027\u9009\u5B9A\u5E76\u5199\u5165 frame.md\uFF0C\u4E4B\u540E\u4E0D\u518D\u66F4\u6539\uFF1B\u6539\u753B\u5E45\u610F\u5473\u7740\u91CD\u5EFA\u9879\u76EE\u3002
\u53EF\u9009\u753B\u5E45\uFF08\u5747 30fps\uFF09\uFF1A
` + canvasOptions() + `
\u975E\u4EA4\u4E92\u73AF\u5883\uFF08CI\u3001\u7BA1\u9053\uFF09\u5FC5\u987B\u663E\u5F0F\u4F20 --canvas\uFF0C\u4E0D\u4F1A\u9759\u9ED8\u53D6\u9ED8\u8BA4\u503C\uFF1B\u4E0D\u4F20\u4E14\u65E0\u6CD5\u4EA4\u4E92\u65F6\u62A5\u9519\u9000\u51FA\u3002

\u89C6\u89C9\u98CE\u683C\u4E0D\u5C5E\u4E8E\u521D\u59CB\u5316\u5951\u7EA6\uFF1A\u753B\u5E45\u51B3\u5B9A\u753B\u5E03\u4E0E\u5B89\u5168\u533A\uFF0C\u914D\u8272\u3001\u5B57\u4F53\u3001\u7248\u5F0F\u3001\u6750\u8D28\u548C\u52A8\u6548
\u7531\u6A21\u578B\u6839\u636E\u672C\u7247\u5185\u5BB9\u4E0E\u5404\u955C\u5934\u6587\u6848\u81EA\u7531\u51B3\u5B9A\u3002\u65E7\u7248\u98CE\u683C\u53C2\u6570\u4ECD\u63A5\u53D7\uFF0C\u4F46\u53EA\u4E3A\u517C\u5BB9\u65E7\u811A\u672C\uFF0C
\u4E0D\u4F1A\u6210\u4E3A\u6E32\u67D3\u63D0\u793A\u8BCD\u6216\u6E32\u67D3\u524D\u7F6E\u6821\u9A8C\u3002
\u65E7\u7248 --style \u53EF\u9009\u503C\uFF08\u4EC5\u7528\u4E8E\u517C\u5BB9\u65E7\u811A\u672C\uFF09\uFF1A
` + styleOptions() + `

frame.md \u4EC5\u4E3A\u65E7\u9879\u76EE\u4FDD\u7559\uFF0C\u4F9B\u753B\u5E45\u7B49\u6280\u672F\u4FE1\u606F\u8BFB\u53D6\uFF1B\u5B83\u4E0D\u518D\u89C4\u5B9A\u955C\u5934\u7684\u89C6\u89C9\u98CE\u683C\u3002

\u5199\u5165\u5185\u5BB9\uFF1A
  PROMPT.md\u3001PROMPT-PRODUCTION.md\u3001article-to-motion.conf\u3001.env.example
  frame.md\uFF08\u753B\u5E45\u6280\u672F\u4FE1\u606F\uFF1B\u65E7\u7248\u98CE\u683C\u53C2\u6570\u4F1A\u5E26\u51FA\u517C\u5BB9\u6587\u4EF6\uFF09\u3001assets/fonts/ \u4E2D\u6587\u5B57\u4F53\u3001assets/style-guide/ \u793A\u4F8B
  templates/project-rules.md\uFF08am run \u636E\u6B64\u6D3E\u751F AGENTS.md / CLAUDE.md \u7B49\uFF09
  .agents/skills/ \u5185\u7F6E\u6280\u80FD\u6811\uFF08text-to-lottie\u3001algorithmic-art\uFF09\uFF0C\u968F\u4E8C\u8FDB\u5236\u4E0B\u53D1

\u4E0D\u8986\u76D6\u5185\u5BB9\u4E0D\u540C\u7684\u5DF2\u6709\u6587\u4EF6\uFF1A\u76EE\u6807\u5DF2\u5B58\u5728\u4E14\u5B57\u8282\u4E0D\u540C\u5C31\u6574\u4F53\u5931\u8D25\u5E76\u56DE\u6EDA\uFF0C\u4E0D\u505A\u5408\u5E76\u3002
\u5B57\u8282\u76F8\u540C\u5219\u89C6\u4E3A\u5DF2\u5B58\u5728\u5E76\u8DF3\u8FC7\uFF0C\u56E0\u6B64\u5BF9\u540C\u4E00\u753B\u5E45\u91CD\u590D\u6267\u884C\u662F\u5E42\u7B49\u7684\uFF0C\u53EF\u5B89\u5168\u7528\u4E8E\u8865\u9F50\u7F3A\u5931\u6587\u4EF6\u3002

\u9ED8\u8BA4\u628A\u56FA\u5B9A\u7248\u672C ` + hyperframesVersion + ` \u7684 HyperFrames \u5B98\u65B9\u6280\u80FD\u4ECE\u672C\u673A\u7F13\u5B58\u62F7\u8FDB\u9879\u76EE\u7684
.agents/skills/\uFF0C\u4E0E\u5185\u7F6E\u6280\u80FD\u6811\u540C\u4E00\u4E2A\u76EE\u5F55\u3002am init \u4E0D\u8054\u7F51\uFF1A\u6280\u80FD\u662F\u524D\u7F6E\u8D44\u6E90\uFF0C\u5148\u8FD0\u884C\u4E00\u6B21
am setup \u628A\u5B83\u4E0B\u8F7D\u8FDB\u7F13\u5B58\uFF1B\u7F13\u5B58\u91CC\u6CA1\u6709\u65F6 am init \u5199\u5B8C\u9879\u76EE\u6587\u4EF6\u540E\u62A5\u9519\uFF0C\u63D0\u793A\u5148 am setup
\u518D\u91CD\u8DD1 am init \u8865\u9F50\u3002--skip-hyperframes \u8DF3\u8FC7\u8FD9\u4E00\u6B65\uFF1B\u5B83\u4E0D\u5F71\u54CD\u5185\u7F6E\u6280\u80FD\u6811\uFF0C\u90A3\u968F\u4E8C\u8FDB\u5236\u4E0B\u53D1\u3002

\u6280\u80FD\u88C5\u8FDB\u9879\u76EE\u800C\u4E0D\u662F\u88C5\u8FDB HOME\uFF0C\u662F\u56E0\u4E3A\u9879\u76EE\u4E4B\u95F4\u4E92\u4E0D\u8986\u76D6\u53EA\u6709\u8FD9\u6837\u624D\u6210\u7ACB\uFF1A\u4E0A\u6E38
\u5B89\u88C5\u5668\u53EA\u8BA4 homedir\uFF0C\u4E00\u53F0\u673A\u5668\u4E0A\u53EA\u6709\u4E00\u4EFD\u6280\u80FD\uFF0C\u4E24\u4E2A\u9879\u76EE\u56FA\u5B9A\u4E0D\u540C\u7248\u672C\u65F6\u8C01\u540E
\u521D\u59CB\u5316\u8C01\u8BF4\u4E86\u7B97\u3002\u88C5\u8FDB\u9879\u76EE\u8FD8\u8BA9\u9879\u76EE\u81EA\u5305\u542B\u2014\u2014\u6574\u4E2A\u76EE\u5F55\u62F7\u5230\u53E6\u4E00\u53F0\u673A\u5668\u5C31\u80FD\u6E32\u67D3\u3002
\u5B89\u88C5\u4E0D\u5199\u4EFB\u4F55 agent \u7684\u6280\u80FD\u76EE\u5F55\u3002\u6821\u9A8C\u8FC7\u7684\u6280\u80FD\u6811\u6309 commit \u7F13\u5B58\u5728
~/.local/share/am/hyperframes/\uFF08\u9075\u5FAA XDG_DATA_HOME\uFF09\uFF0C\u6240\u6709\u9879\u76EE\u4ECE\u8FD9\u91CC\u62F7\u8D1D\u3002

\u6280\u80FD\u4E0D\u8D70\u4E0A\u6E38\u5B89\u88C5\u5668\uFF1A\u5B83\u53EA\u514B\u9686\u4ED3\u5E93\u9ED8\u8BA4\u5206\u652F\uFF0C\u6CA1\u6709\u6307\u5B9A tag \u7684\u53E3\u5B50\uFF0C\u540C\u4E00\u4E2A\u7248\u672C\u53F7
\u9694\u51E0\u5929\u88C5\u51FA\u6765\u7684\u6280\u80FD\u53EF\u4EE5\u4E0D\u540C\u3002am \u81EA\u5DF1\u6309 tag \u6D45\u514B\u9686\u5E76\u6821\u9A8C commit \u4E0E\u6280\u80FD\u6570\u91CF\uFF0C
\u4E24\u6B21\u521D\u59CB\u5316\u7684\u6280\u80FD\u6811\u9010\u5B57\u8282\u4E00\u81F4\u3002\u5B89\u88C5\u540E\u5728 .agents/skills/` + ManifestFile + `
\u91CC\u8BB0\u4E0B\u7248\u672C\u3001\u4E0A\u6E38 commit \u4E0E\u6BCF\u4E2A\u6280\u80FD\u7684\u5185\u5BB9\u6458\u8981\u3002

\u4E0A\u6E38\u6280\u80FD\u4E0E\u5185\u7F6E\u6280\u80FD\u91CD\u540D\u65F6\u4FDD\u7559\u5185\u7F6E\u7248\u672C\u5E76\u544A\u8B66\uFF0C\u4E0D\u4F1A\u8986\u76D6\u672C\u4ED3\u5E93 fork \u8FC7\u7684\u6280\u80FD\u3002

\u53D9\u4E8B\u6A21\u5F0F\u7531 --narration \u4E00\u6B21\u6027\u9009\u5B9A\uFF0C\u9ED8\u8BA4 solo\uFF08\u5355\u53E3\u64AD\uFF09\u3002\u4F20 cast \u4F1A\u989D\u5916\u5728
\u9879\u76EE\u6839\u5199 cast.yaml \u5E76\u5EFA\u51FA\u7A7A\u7684 cast/ \u76EE\u5F55\uFF0C\u8FDB\u5165\u591A\u89D2\u8272\u5BF9\u8BDD\u53D9\u4E8B\u6A21\u5F0F\uFF1B\u6B64\u65F6
production \u9636\u6BB5\u7684 TTS \u4E0E\u65F6\u95F4\u7EBF\u88C5\u914D\u89C4\u7A0B\u6539\u4E3A\u9075\u5B88\u968F\u9879\u76EE\u4E0B\u53D1\u7684
PROMPT-CAST-ADDENDUM.md\uFF0C\u5177\u4F53\u89C4\u5219\u89C1\u8BE5\u6587\u4EF6\u3002cast.yaml \u521A\u5EFA\u51FA\u65F6 packs \u4E3A\u7A7A
\u5217\u8868\uFF0C\u8FD9\u662F\u9884\u671F\u72B6\u6001\uFF1A\u9879\u76EE\u5728\u7B2C\u4E00\u6B21 am cast add / am cast new \u4E4B\u524D\u672C\u6765\u5C31\u8FD8
\u6CA1\u6709\u53EF\u7528\u89D2\u8272\u3002

--film-style \u7ED9\u5168\u7247\u9009\u4E00\u79CD\u6574\u7247\u98CE\u683C\uFF08\u5404\u98CE\u683C\u6765\u6E90\u7684\u98CE\u683C\uFF0Cam film-style list \u67E5\u770B\uFF09\uFF0C
\u7B49\u540C\u4E8E\u521D\u59CB\u5316\u540E\u8FD0\u884C am film-style use\uFF1B\u4E0D\u4F20\u65F6\u5404\u955C\u5934\u81EA\u4E3B\u5B9A\u89C6\u89C9\uFF0C\u4E4B\u540E\u4E5F\u53EF\u4EE5\u518D\u9009\u3002
\u98CE\u683C\u5E93\u540C\u6837\u662F\u524D\u7F6E\u8D44\u6E90\uFF08am setup \u4E0B\u8F7D\uFF09\uFF0C\u8FD9\u91CC\u4E0D\u8054\u7F51\uFF0C\u4E0D\u53D7 --skip-hyperframes \u5F71\u54CD\u3002`,
    example: `  # \u4EA4\u4E92\u9009\u62E9\u753B\u5E45
  am init my-video

  # \u975E\u4EA4\u4E92\u73AF\u5883\u5FC5\u987B\u663E\u5F0F\u6307\u5B9A\u753B\u5E45
  am init my-video --canvas vertical-9x16

  # \u753B\u5E45\u4E4B\u5916\u4E0D\u6307\u5B9A\u89C6\u89C9\u98CE\u683C\uFF0C\u955C\u5934\u7531\u6A21\u578B\u81EA\u7531\u521B\u4F5C
  am init my-video --canvas vertical-9x16

  # \u79BB\u7EBF\u6216 CI\uFF1A\u8DF3\u8FC7\u8054\u7F51\u5B89\u88C5 HyperFrames \u6280\u80FD
  am init my-video --canvas vertical-3x4 --skip-hyperframes

  # \u5728\u5F53\u524D\u76EE\u5F55\u8865\u9F50\u7F3A\u5931\u7684\u9AA8\u67B6\u6587\u4EF6\uFF08\u5E42\u7B49\uFF09
  am init --canvas vertical-3x4

  # \u591A\u89D2\u8272\u5BF9\u8BDD\u53D9\u4E8B\uFF1A\u989D\u5916\u5199\u51FA cast.yaml \u4E0E cast/
  am init my-story --canvas vertical-3x4 --narration cast

  # \u5168\u7247\u7528\u540C\u4E00\u79CD\u98CE\u683C\uFF08\u6CB9\u753B\u539A\u6D82\uFF09
  am init my-video --canvas landscape-16x9 --film-style lemo-opuscar/impasto`,
    args: maxArgs(1, "DIR"),
    runE: async (cmd, args) => {
      if (narration.value !== narrationSolo && narration.value !== narrationCast) {
        throw new Error(`\u65E0\u6548\u7684 --narration: ${narration.value}\uFF08\u53EF\u9009\uFF1A${narrationSolo} ${narrationCast}\uFF09`);
      }
      const target = import_node_path24.default.resolve(args.length === 1 ? args[0] : ".");
      if (!["speech", "song", "beat"].includes(delivery.value)) throw new Error("--delivery \u5FC5\u987B\u4E3A speech\u3001song \u6216 beat");
      validate({ target, canvas: "", style: CustomStyle, delivery: delivery.value, narration: narration.value });
      const filmStyle = filmStyleName.value !== "" ? lookup(filmStyleName.value) : void 0;
      const chosen = await resolveCanvas(canvasID.value, process.stdin, stdout);
      const style3 = resolveStyle(styleID.value);
      const brief = resolveStyleBrief(style3, styleBrief.value, styleBriefFile.value);
      const extra = {};
      if (brief !== "") extra[styleBriefPath] = styleBriefDocument(brief);
      const result = create({ target, canvas: chosen.id, style: style3, delivery: delivery.value, narration: narration.value, extra });
      stdout.write(`\u9879\u76EE\u5DF2\u521D\u59CB\u5316\uFF1A${target}\uFF08\u753B\u5E45 ${chosen.label}\uFF0C\u65B0\u589E ${result.created}\uFF0C\u672A\u53D8 ${result.unchanged}\uFF09
`);
      if (filmStyle) {
        let installed3;
        try {
          installed3 = install2({ projectDir: target, style: filmStyle, env: currentEnvironment() });
        } catch (err) {
          throw new Error(`\u9879\u76EE\u6587\u4EF6\u5DF2\u5199\u5165\uFF0C\u4F46\u6574\u7247\u98CE\u683C\u5B89\u88C5\u5931\u8D25\uFF08\u4E4B\u540E\u53EF\u7528 am film-style use ${styleKey(filmStyle)} \u91CD\u8BD5\uFF09\uFF1A${err.message}`);
        }
        reportFilmStyle(stdout, filmStyle, installed3);
      }
      if (skipHyperframes.value) {
        stdout.write("\u8B66\u544A\uFF1A\u5DF2\u8DF3\u8FC7 HyperFrames \u6280\u80FD\u5B89\u88C5\n");
        return;
      }
      let installed2;
      try {
        installed2 = await installSkills(target, currentEnvironment(), stderr, skillsProgressPrinter(stderr), cmd.context());
      } catch (err) {
        throw new Error(`\u9879\u76EE\u6587\u4EF6\u5DF2\u5199\u5165\uFF0C\u4F46 HyperFrames \u6280\u80FD\u6CA1\u88C5\u8FDB\u9879\u76EE\uFF08\u51C6\u5907\u597D\u540E\u91CD\u8DD1 am init \u8865\u9F50\uFF09\uFF1A${err.message}`);
      }
      stdout.write(`HyperFrames ${hyperframesVersion} \u6280\u80FD\u5DF2\u88C5\u5165 ${SkillsSubdir}\uFF08${installed2.installed.length} \u4E2A\uFF09
`);
      try {
        requireCLI(currentEnvironment());
      } catch (cliErr) {
        stderr.write(`\u8B66\u544A\uFF1A${cliErr.message}
`);
      }
      for (const name of installed2.protected) stderr.write(`\u8B66\u544A\uFF1A\u4E0A\u6E38\u6280\u80FD ${name} \u4E0E\u5185\u7F6E\u6280\u80FD\u91CD\u540D\uFF0C\u5DF2\u4FDD\u7559\u5185\u7F6E\u7248\u672C
`);
    }
  });
  const flags = initCmd.flags();
  flags.boolVar(skipHyperframes, "skip-hyperframes", false, "\u8DF3\u8FC7\u4ECE\u672C\u673A\u7F13\u5B58\u62F7\u5165 HyperFrames \u5B98\u65B9\u6280\u80FD\uFF1B\u4E0D\u5F71\u54CD\u968F\u4E8C\u8FDB\u5236\u4E0B\u53D1\u7684\u5185\u7F6E\u6280\u80FD\u6811");
  flags.stringVar(canvasID, "canvas", "", "\u753B\u5E45\u9884\u8BBE\uFF1A" + ids().join(" | ") + "\uFF1B\u4E0D\u4F20\u5219\u5728\u7EC8\u7AEF\u91CC\u4EA4\u4E92\u9009\u62E9");
  flags.stringVar(styleID, "style", "", "\u65E7\u7248\u89C6\u89C9\u98CE\u683C\u53C2\u6570\uFF08\u4EC5\u517C\u5BB9\uFF0C\u4E0D\u4F5C\u4E3A\u6E32\u67D3\u8981\u6C42\uFF09\uFF1A" + [...styleIDs(), CustomStyleFlag].join(" | "));
  flags.stringVar(styleBrief, "style-brief", "", "\u65E7\u7248\u81EA\u5B9A\u4E49\u98CE\u683C\u63CF\u8FF0\uFF08\u4EC5\u517C\u5BB9\uFF09\uFF0C\u53EA\u80FD\u4E0E --style " + CustomStyleFlag + " \u4E00\u8D77\u4F7F\u7528");
  flags.stringVar(styleBriefFile, "style-brief-file", "", "\u4ECE\u6587\u4EF6\u8BFB\u53D6\u65E7\u7248\u81EA\u5B9A\u4E49\u98CE\u683C\u63CF\u8FF0\uFF0C\u4E0E --style-brief \u4E8C\u9009\u4E00");
  flags.stringVar(narration, "narration", narrationSolo, "\u53D9\u4E8B\u6A21\u5F0F\uFF1A" + narrationSolo + "\uFF08\u5355\u53E3\u64AD\uFF0C\u9ED8\u8BA4\uFF09 | " + narrationCast + "\uFF08\u591A\u89D2\u8272\u5BF9\u8BDD\uFF0C\u989D\u5916\u5199\u51FA cast.yaml \u4E0E cast/\uFF09");
  flags.stringVar(filmStyleName, "film-style", "", "\u6574\u7247\u98CE\u683C\uFF1A\u6765\u6E90/\u76EE\u5F55\u540D\uFF0C\u6216\u552F\u4E00\u7684\u76EE\u5F55\u540D\u3001\u4E2D\u6587\u540D\u3001\u82F1\u6587\u540D\uFF08am film-style list\uFF09\uFF1B\u4E0D\u4F20\u5219\u5404\u955C\u5934\u81EA\u4E3B\u5B9A\u89C6\u89C9");
  flags.stringVar(delivery, "delivery", "speech", "\u8BB2\u89E3\u5F62\u5F0F\uFF1Aspeech\uFF08\u9ED8\u8BA4\uFF09\u3001song\uFF08\u5355\u4EBA\u6574\u66F2\uFF09\u6216 beat\uFF08\u65E0\u914D\u97F3\u5361\u70B9\uFF09");
  return initCmd;
}
function newConfigCommand(stdout) {
  const configCmd = new Command({
    use: "config",
    short: "\u8BFB\u53D6\u89E3\u6790\u540E\u7684\u914D\u7F6E",
    long: `\u8BFB\u53D6 am \u89E3\u6790\u540E\u7684\u914D\u7F6E\u503C\u3002

\u4E0D\u8981\u81EA\u5DF1\u53BB\u8BFB article-to-motion.conf \u6216 .env\u2014\u2014\u89E3\u6790\u6D89\u53CA\u56DB\u5C42\u4F18\u5148\u7EA7
\uFF08\u73AF\u5883\u53D8\u91CF > \u9879\u76EE .env > article-to-motion.conf > \u5185\u7F6E\u9ED8\u8BA4\uFF09\uFF0C\u53EA\u6709\u672C\u547D\u4EE4\u7684
\u8F93\u51FA\u7B49\u4E8E am \u5B9E\u9645\u4F1A\u7528\u7684\u503C\u3002`
  });
  configCmd.addCommand(
    new Command({
      use: "get ORCHESTRATOR|RENDERER|TTS_PROVIDER|ALIGN_PROVIDER",
      args: exactArgs(1, "KEY"),
      short: "\u6253\u5370\u5355\u4E2A\u914D\u7F6E\u952E",
      long: `\u628A\u5355\u4E2A\u914D\u7F6E\u952E\u7684\u89E3\u6790\u7ED3\u679C\u6253\u5370\u5230 stdout\uFF0C\u53EA\u6709\u503C\u672C\u8EAB\u52A0\u4E00\u4E2A\u6362\u884C\uFF0C\u4FBF\u4E8E\u76F4\u63A5\u6355\u83B7\u3002

\u53EF\u7528\u952E\uFF1A
  ORCHESTRATOR   \u7F16\u6392\u5DE5\u5177\uFF1Acodex | claude | qoder | codebuddy | opencode
  RENDERER       \u6E32\u67D3\u5DE5\u5177\uFF1A\u540C\u4E0A\u53D6\u503C\u8303\u56F4
  TTS_PROVIDER   \u8BED\u97F3\u5408\u6210\uFF1A` + ttsProviderIDs().split(" ").join(" | ") + `
  ALIGN_PROVIDER \u5DF2\u77E5\u6587\u672C\u5F3A\u5236\u5BF9\u9F50\uFF1A` + alignerIDs().split(" ").join(" | ") + `
                 auto \u5728 Apple Silicon \u4E0A\u89E3\u6790\u4E3A mlx\uFF0C\u5176\u4F59\u5E73\u53F0\u4E3A funasr\uFF1B
                 \u672C\u547D\u4EE4\u6253\u5370\u7684\u662F\u89E3\u6790\u540E\u7684\u5177\u4F53\u5DE5\u5177\uFF0C\u4E0D\u4F1A\u662F auto

\u5728\u5F53\u524D\u5DE5\u4F5C\u76EE\u5F55\u89E3\u6790\u914D\u7F6E\uFF0C\u56E0\u6B64\u8981\u5728\u9879\u76EE\u6839\u8FD0\u884C\u3002\u952E\u540D\u672A\u77E5\u6216\u89E3\u6790\u51FA\u7684\u503C\u975E\u6CD5\u65F6\u9000\u51FA\u7801 1\u3002`,
      example: `  # \u6355\u83B7\u89E3\u6790\u540E\u7684\u6E32\u67D3\u5DE5\u5177
  renderer="$(am config get RENDERER)"

  # \u73AF\u5883\u53D8\u91CF\u4F18\u5148\u7EA7\u6700\u9AD8\uFF0C\u53EF\u4E34\u65F6\u8986\u76D6
  RENDERER=codex am config get RENDERER`,
      runE: (_cmd, args) => {
        const cfg = load(".", null);
        const values = { ORCHESTRATOR: cfg.orchestrator, RENDERER: cfg.renderer, TTS_PROVIDER: cfg.ttsProvider, ALIGN_PROVIDER: cfg.alignProvider };
        if (!Object.hasOwn(values, args[0])) throw new Error(`\u672A\u77E5\u914D\u7F6E\u952E\uFF1A${args[0]}`);
        stdout.write(values[args[0]] + "\n");
      }
    })
  );
  return configCmd;
}
function archiveStamp(now = /* @__PURE__ */ new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}
function readLine() {
  const buf = Buffer.alloc(1);
  let line2 = "";
  try {
    while (import_node_fs28.default.readSync(0, buf, 0, 1, null) === 1) {
      const ch = buf.toString("utf8");
      line2 += ch;
      if (ch === "\n") break;
    }
  } catch {
  }
  return line2;
}
function newArchiveCommand(stdout) {
  const mainRef = ref("");
  const archiveRoot = ref("");
  const archiveName = ref("");
  const yes = ref(false);
  const dryRun = ref(false);
  const archiveCmd = new Command({
    use: "archive",
    short: "\u5F52\u6863\u5F53\u524D\u9879\u76EE\u5E76\u590D\u4F4D\u5230 main",
    long: `\u628A\u672C\u7247\u7684\u5355\u7247\u6587\u4EF6\u8FDE\u540C SHA-256 \u6E05\u5355\u79FB\u51FA\u4ED3\u5E93\uFF0C\u5E76\u628A\u5DE5\u4F5C\u533A\u590D\u4F4D\u5230\u51BB\u7ED3\u7684 main \u63D0\u4EA4\u3002

\u7834\u574F\u6027\u64CD\u4F5C\uFF0C\u4E14\u4E0D\u5C5E\u4E8E\u6210\u7247\u9A8C\u6536\u7684\u4E00\u90E8\u5206\u3002\u672A\u7ECF\u7528\u6237\u660E\u786E\u786E\u8BA4\u4E0D\u8981\u6267\u884C\uFF1A
\u5148\u8DD1 --dry-run \u770B\u8BA1\u5212\uFF0C\u628A\u7ED3\u679C\u539F\u6837\u6C47\u62A5\u7ED9\u7528\u6237\uFF0C\u7531\u7528\u6237\u51B3\u5B9A\u662F\u5426\u7EE7\u7EED\u3002

\u4F1A\u628A\u76F8\u5BF9 main \u7684\u6539\u52A8\u5206\u6210\u4E09\u7C7B\uFF0C\u53EA\u6709\u7B2C\u4E00\u7C7B\u4F1A\u88AB\u5F52\u6863\uFF1A
  \u5019\u9009\u6587\u4EF6   main \u63D0\u4EA4\u91CC\u4E0D\u5B58\u5728\u7684\u65B0\u589E\u6587\u4EF6\uFF0C\u4EE5\u53CA\u5168\u90E8\u672A\u8DDF\u8E2A\u6587\u4EF6 \u2192 \u79FB\u5165\u5F52\u6863\u76EE\u5F55
  \u5171\u4EAB\u4FEE\u6539   main \u63D0\u4EA4\u91CC\u5DF2\u5B58\u5728\u5374\u88AB\u6539\u52A8\u7684\u6587\u4EF6 \u2192 \u89C6\u4E3A\u963B\u65AD
  ignored   \u88AB .gitignore \u5FFD\u7565\u4F46\u5B58\u5728\u4E8E\u5DE5\u4F5C\u533A\u7684\u6587\u4EF6 \u2192 \u89C6\u4E3A\u963B\u65AD

\u5B58\u5728\u5171\u4EAB\u4FEE\u6539\u6216 ignored \u6587\u4EF6\u65F6\u62D2\u7EDD\u6267\u884C\u5E76\u62A5\u544A\u3002\u4E0D\u8981\u4E3A\u4E86\u8BA9\u5B83\u901A\u8FC7\u800C\u5220\u6587\u4EF6\u3001\u79FB\u6587\u4EF6\u3001
\u6539 .gitignore \u6216\u91CD\u7F6E\u5DE5\u4F5C\u533A\u2014\u2014\u90A3\u4F1A\u63A9\u76D6\u95EE\u9898\u3002\u4E5F\u4E0D\u8981\u5220\u9664\u9879\u76EE\u5206\u652F\u6216\u6539\u5199 Git \u5386\u53F2\u3002

--archive-name \u7F3A\u7701\u4E3A project-<\u5E74\u6708\u65E5-\u65F6\u5206\u79D2>\u3002\u6210\u529F\u540E\u5DE5\u4F5C\u533A detach \u5230 --main-ref
\u6307\u5411\u7684\u63D0\u4EA4\u3002\u9664\u975E\u4F20 --yes\uFF0C\u5426\u5219\u4F1A\u5728 stdin \u4E0A\u4EA4\u4E92\u786E\u8BA4\uFF1B\u975E\u4EA4\u4E92\u73AF\u5883\u4E0B\u6CA1\u6709 --yes \u4F1A\u53D6\u6D88\u3002`,
    example: `  # \u5148\u770B\u8BA1\u5212\uFF0C\u4E0D\u505A\u4EFB\u4F55\u6539\u52A8
  am archive --dry-run

  # \u7528\u6237\u786E\u8BA4\u540E\u6267\u884C
  am archive

  # \u975E\u4EA4\u4E92\u73AF\u5883\u5FC5\u987B\u663E\u5F0F\u8DF3\u8FC7\u786E\u8BA4
  am archive --yes --archive-root ~/video-archive --archive-name my-video-2026-08`,
    args: noArgs,
    runE: () => {
      const name = archiveName.value || "project-" + archiveStamp();
      const plan = buildPlan(".", mainRef.value, archiveRoot.value, name);
      stdout.write(`\u5F52\u6863\u76EE\u6807\uFF1A${plan.destination}
\u5019\u9009\u6587\u4EF6\uFF1A${plan.candidates.length}
\u5171\u4EAB\u4FEE\u6539\uFF1A${plan.shared.length}
ignored\uFF1A${plan.ignored.length}
`);
      if (dryRun.value) return;
      if (!yes.value) {
        stdout.write("\u786E\u8BA4\u5F52\u6863\u5E76\u590D\u4F4D\u5230 main\uFF1F[y/N] ");
        if (readLine().trim().toLowerCase() !== "y") throw new Error("\u7528\u6237\u53D6\u6D88\u5F52\u6863");
      }
      execute2(plan);
    }
  });
  const flags = archiveCmd.flags();
  flags.stringVar(mainRef, "main-ref", "main", "\u51BB\u7ED3\u7684 main ref\uFF0C\u5F52\u6863\u540E\u5DE5\u4F5C\u533A detach \u5230\u5B83\u6307\u5411\u7684\u63D0\u4EA4");
  flags.stringVar(archiveRoot, "archive-root", "", "\u5F52\u6863\u7236\u76EE\u5F55\uFF0C\u987B\u5728\u4ED3\u5E93\u4E4B\u5916");
  flags.stringVar(archiveName, "archive-name", "", "\u5F52\u6863\u76EE\u5F55\u540D\uFF0C\u7F3A\u7701\u4E3A project-<\u5E74\u6708\u65E5-\u65F6\u5206\u79D2>");
  flags.boolVar(yes, "yes", false, "\u8DF3\u8FC7\u4EA4\u4E92\u786E\u8BA4\uFF1B\u975E\u4EA4\u4E92\u73AF\u5883\u6267\u884C\u5F52\u6863\u65F6\u5FC5\u987B\u4F20");
  flags.boolVar(dryRun, "dry-run", false, "\u53EA\u6253\u5370\u8BA1\u5212\uFF0C\u4E0D\u79FB\u52A8\u4EFB\u4F55\u6587\u4EF6\u3001\u4E0D\u6539\u52A8\u5DE5\u4F5C\u533A");
  return archiveCmd;
}

// src/setup.ts
var import_node_fs29 = __toESM(require("node:fs"), 1);
var import_node_path25 = __toESM(require("node:path"), 1);

// ../engine/src/prereqs/index.ts
function hyperframesStage(p) {
  if (p.indeterminate || p.percent <= 0 || p.percent >= 100) return p.stage;
  return `${p.stage} ${Math.trunc(p.percent)}%`;
}
function items() {
  const version = PinnedVersion;
  const out = [
    {
      group: "skills",
      id: "skills",
      required: true,
      name: "HyperFrames \u6280\u80FD",
      version,
      ready: (env) => {
        const dir = defaultCacheDir(env);
        return [skillsReady(dir), dir];
      },
      prepare: (run2, signal) => prepareSkills(
        { env: run2.git, cacheDir: defaultCacheDir(run2.base), output: run2.log, progress: (p) => run2.stage(hyperframesStage(p)) },
        signal
      )
    },
    {
      group: "cli",
      id: "cli",
      required: true,
      name: "HyperFrames CLI",
      version,
      ready: (env) => {
        const dir = cliDir(env, PinnedVersion);
        return [cliReady(dir, PinnedVersion), dir];
      },
      prepare: async (run2, signal) => {
        await ensureCLI({ env: run2.npm, output: run2.log, progress: (p) => run2.stage(hyperframesStage(p)) }, signal);
      }
    }
  ];
  for (const source of sources()) {
    out.push({
      group: "styles",
      id: "styles:" + source.id(),
      name: "\u6574\u7247\u98CE\u683C " + source.id(),
      version: "",
      required: false,
      ready: (env) => {
        let ok = true;
        try {
          source.check(env);
        } catch {
          ok = false;
        }
        return [ok, source.location(env)];
      },
      // 来源可能既用 git 又用 npm：git 的代理与 npm 的源合在一份环境里。
      prepare: (run2, signal) => source.prepare({ env: run2.mixed, output: run2.log, progress: (p) => run2.stage(`(${p.step}/${p.steps}) ${p.stage}`) }, signal)
    });
  }
  return out;
}

// src/setupview.ts
var import_node_os4 = __toESM(require("node:os"), 1);
var spinnerFrames = ["\u280B", "\u2819", "\u2839", "\u2838", "\u283C", "\u2834", "\u2826", "\u2827", "\u2807", "\u280F"];
var SetupView = class {
  constructor(out, names, versions, tty = false) {
    this.out = out;
    this.tty = tty;
    this.color = this.tty && !process.env.NO_COLOR && process.env.TERM !== "dumb";
    this.items = names.map((name, i) => ({ name, version: versions[i], state: 0 /* Pending */, detail: "", started: 0, ended: 0, lastPrinted: "" }));
  }
  out;
  tty;
  items;
  drawn = 0;
  frame = 0;
  timer;
  color;
  /** 开始重画（终端里每 100 毫秒一次）。 */
  start() {
    if (!this.tty) return;
    this.timer = setInterval(() => {
      this.frame++;
      this.redraw();
    }, 100);
  }
  /** 停止重画并画最后一次。 */
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = void 0;
    if (this.tty) this.redraw();
  }
  /** 改一项的状态与进展说明。 */
  set(index, state, detail) {
    const item = this.items[index];
    if (state === 1 /* Running */ && item.state !== 1 /* Running */) item.started = Date.now();
    if ((state === 3 /* Done */ || state === 4 /* Failed */) && item.ended === 0) item.ended = Date.now();
    item.state = state;
    item.detail = detail;
    if (this.tty) {
      this.redraw();
      return;
    }
    const line2 = this.line(index);
    if (line2 !== item.lastPrinted) {
      item.lastPrinted = line2;
      this.out.write(line2 + "\n");
    }
  }
  /** 标成「本来就已就绪」，不在屏幕上打行（am setup 开头先标好已就绪的项）。 */
  markReady(index) {
    this.items[index].state = 2 /* Ready */;
  }
  /** 只改进展说明（进行中的阶段）。 */
  detail(index, detail) {
    this.set(index, this.items[index].state, detail);
  }
  redraw() {
    let b = this.drawn > 0 ? `\x1B[${this.drawn}A` : "";
    for (let i = 0; i < this.items.length; i++) b += "\r\x1B[K" + this.line(i) + "\n";
    this.drawn = this.items.length;
    this.out.write(b);
  }
  /** 列宽：名字与版本按显示宽度（中文算两列）补齐。 */
  widths() {
    let name = 0;
    let version = 0;
    for (const item of this.items) {
      name = Math.max(name, displayWidth(item.name));
      version = Math.max(version, displayWidth(item.version));
    }
    return [name, version];
  }
  line(index) {
    const item = this.items[index];
    const [nameWidth, versionWidth] = this.widths();
    let icon = "";
    let detail = "";
    switch (item.state) {
      case 0 /* Pending */:
        icon = this.paint("2", "\xB7");
        detail = this.paint("2", "\u7B49\u5F85");
        break;
      case 1 /* Running */:
        icon = this.paint("36", this.tty ? spinnerFrames[this.frame % spinnerFrames.length] : "\u203A");
        detail = item.detail;
        if (this.tty) detail += "  " + this.paint("2", clock(Date.now() - item.started));
        break;
      case 2 /* Ready */:
        icon = this.paint("32", "\u2713");
        detail = this.paint("2", "\u5DF2\u5C31\u7EEA");
        break;
      case 3 /* Done */:
        icon = this.paint("32", "\u2713");
        detail = "\u5B8C\u6210 " + this.paint("2", "\xB7 " + clock(item.ended - item.started));
        break;
      case 4 /* Failed */:
        icon = this.paint("31", "\u2717");
        detail = this.paint("31", "\u5931\u8D25");
        break;
    }
    let version = pad2(item.version, versionWidth);
    if (versionWidth > 0) version = this.paint("2", version) + "  ";
    return "  " + icon + " " + pad2(item.name, nameWidth) + "  " + version + detail;
  }
  paint(code, text) {
    return this.color ? `\x1B[${code}m${text}\x1B[0m` : text;
  }
};
function clock(ms) {
  const seconds = Math.floor(Math.abs(ms) / 1e3 + 0.5) * Math.sign(ms || 1);
  return `${Math.trunc(seconds / 60)}:${String(Math.abs(seconds % 60)).padStart(2, "0")}`;
}
function pad2(text, width) {
  return text + " ".repeat(Math.max(0, width - displayWidth(text)));
}
var wide = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}＀-￯　-〿]/u;
function displayWidth(text) {
  let width = 0;
  for (const ch of text) width += wide.test(ch) ? 2 : 1;
  return width;
}
function tailLines(text, n) {
  const out = [];
  const lines = text.replace(/\r/g, "\n").split("\n");
  for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
    const line2 = lines[i].replace(/[ \t]+$/, "");
    if (line2.trim() !== "") out.unshift(line2);
  }
  return out;
}
function homeShort(path27) {
  const home = import_node_os4.default.homedir();
  return home && path27.startsWith(home) ? "~" + path27.slice(home.length) : path27;
}

// src/setup.ts
function newSetupCommand(stdout, _stderr) {
  const check3 = ref(false);
  const only = ref([]);
  const proxy = ref("");
  const npmRegistry = ref("");
  const cmd = new Command({
    use: "setup",
    args: noArgs,
    short: "\u4E0B\u8F7D\u5E76\u51C6\u5907\u5168\u90E8\u524D\u7F6E\u8D44\u6E90\uFF08HyperFrames \u6280\u80FD\u4E0E CLI\u3001\u6574\u7247\u98CE\u683C\u6765\u6E90\uFF09",
    long: `\u8981\u8054\u7F51\u7684\u4E1C\u897F\u90FD\u7531\u8FD9\u4E00\u6761\u547D\u4EE4\u51C6\u5907\uFF0C\u653E\u5728\u7528\u6237\u7EA7\u76EE\u5F55\u91CC\uFF0C\u6240\u6709\u9879\u76EE\u5171\u7528\uFF1A

  skills   HyperFrames ` + hyperframesVersion + ` \u5B98\u65B9\u6280\u80FD\uFF08git\uFF0C\u7F13\u5B58\u5728 ~/.local/share/am/hyperframes/<commit>\uFF09
  cli      HyperFrames CLI ` + hyperframesVersion + `\uFF08npm\uFF0C\u88C5\u5728 ~/.local/share/am/hyperframes/cli-<\u7248\u672C>\uFF09
  styles   \u6BCF\u4E2A\u6574\u7247\u98CE\u683C\u6765\u6E90\u4E00\u9879\uFF08styles:<\u6765\u6E90>\uFF09\uFF0C\u6570\u636E\u653E\u5728 ~/.local/share/am/film-styles/<\u6765\u6E90>\uFF1B
           \u5DF2\u767B\u8BB0\u7684\u6765\u6E90\uFF1A
` + sourceSummary() + `

\u5176\u4F59\u547D\u4EE4\uFF08am init\u3001am film-style use\u3001am scene run\u3001am hyperframes\u3001am studio\uFF09\u53EA\u68C0\u67E5
\u4E0D\u4E0B\u8F7D\uFF0C\u7F3A\u4E86\u5C31\u63D0\u793A\u5148\u8FD0\u884C am setup\u3002\u5DF2\u5C31\u7EEA\u7684\u9879\u76F4\u63A5\u8DF3\u8FC7\uFF1B\u4E0B\u8F7D\u65AD\u4E86\u518D\u8FD0\u884C\u4E00\u6B21\u4F1A\u63A5\u7740\u4E0B\u3002
git \u4E0E npm \u7684\u539F\u59CB\u8F93\u51FA\u5199\u8FDB ~/.local/share/am/setup.log\uFF0C\u5931\u8D25\u65F6\u5C4F\u5E55\u4E0A\u7ED9\u51FA\u6700\u540E\u51E0\u884C\u3002

--proxy \u53EA\u7ED9 git\uFF08GitHub\uFF09\u7528\uFF0C\u4F8B\u5982\u672C\u673A\u7684 Clash\uFF1Bnpm \u7167\u5E38\u7528\u4F60 ~/.npmrc \u91CC\u7684\u955C\u50CF\u4E0E\u4EE3\u7406\uFF0C
\u8981\u4E34\u65F6\u6362\u6E90\u7528 --npm-registry\u3002--only \u8BA4 skills\u3001cli\u3001styles\uFF08\u5168\u90E8\u98CE\u683C\u6765\u6E90\uFF09\u6216
styles:<\u6765\u6E90>\u3002--check \u53EA\u62A5\u544A\u54EA\u4E9B\u5DF2\u5C31\u7EEA\u3001\u54EA\u4E9B\u7F3A\uFF0C\u4E0D\u4E0B\u8F7D\uFF1B\u6709\u7F3A\u9879\u65F6\u9000\u51FA\u7801\u4E3A 1\u3002`,
    example: `  am setup
  am setup --proxy http://127.0.0.1:7890
  am setup --only styles --proxy http://127.0.0.1:7890
  am setup --only styles:lemo-opuscar
  am setup --check`,
    runE: async (c) => {
      const env = currentEnvironment();
      const selected2 = selectSetupItems(items(), only.value);
      if (check3.value) return setupCheck(stdout, env, selected2);
      return setupPrepare(c.context(), stdout, env, selected2, proxy.value, npmRegistry.value);
    }
  });
  cmd.flags().boolVar(check3, "check", false, "\u53EA\u68C0\u67E5\u54EA\u4E9B\u5DF2\u5C31\u7EEA\uFF0C\u4E0D\u4E0B\u8F7D\uFF1B\u6709\u7F3A\u9879\u65F6\u9000\u51FA\u7801\u4E3A 1");
  cmd.flags().stringSliceVar(only, "only", [], "\u53EA\u51C6\u5907\u5176\u4E2D\u51E0\u9879\uFF1Askills\u3001cli\u3001styles \u6216 styles:<\u6765\u6E90>\uFF08\u53EF\u9017\u53F7\u5206\u9694\uFF09");
  cmd.flags().stringVar(proxy, "proxy", "", "git \u4E0B\u8F7D\uFF08GitHub\uFF09\u7528\u7684\u4EE3\u7406\uFF0C\u4F8B\u5982 http://127.0.0.1:7890\uFF1B\u4E0D\u5F71\u54CD npm");
  cmd.flags().stringVar(npmRegistry, "npm-registry", "", "npm \u7528\u7684\u6E90\uFF0C\u8986\u76D6 ~/.npmrc \u7684 registry");
  return cmd;
}
function selectSetupItems(items2, only) {
  const wanted = /* @__PURE__ */ new Set();
  for (const value of only) for (const id of value.split(",")) if (id.trim() !== "") wanted.add(id.trim());
  for (const id of wanted) {
    if (!items2.some((item) => item.id === id || item.group === id)) {
      throw new Error(`--only \u4E0D\u8BA4 ${goQuote(id)}\uFF08\u53EF\u9009\uFF1Askills\u3001cli\u3001styles\u3001${items2.map((item) => item.id).join("\u3001")}\uFF09`);
    }
  }
  return items2.filter((item) => wanted.size === 0 || wanted.has(item.id) || wanted.has(item.group));
}
function newItemsView(stdout, items2) {
  return new SetupView(
    stdout,
    items2.map((item) => item.name),
    items2.map((item) => item.version),
    Boolean(stdout.isTTY)
  );
}
function setupCheck(stdout, env, items2) {
  const view3 = newItemsView(stdout, items2);
  const [nameWidth, versionWidth] = view3.widths();
  stdout.write("\n");
  let missing2 = 0;
  for (const item of items2) {
    const [ok, where] = item.ready(env);
    let icon = view3.paint("32", "\u2713");
    let state = "\u5DF2\u5C31\u7EEA";
    if (!ok) {
      icon = view3.paint("31", "\u2717");
      state = view3.paint("31", "\u7F3A");
      missing2++;
    }
    const version = versionWidth > 0 ? view3.paint("2", pad2(item.version, versionWidth)) + "  " : "";
    stdout.write(`  ${icon} ${pad2(item.name, nameWidth)}  ${version}${pad2(state, 6)}  ${view3.paint("2", homeShort(where))}
`);
  }
  stdout.write("\n");
  if (missing2 > 0) {
    stdout.write(`\u7F3A ${missing2} \u9879\uFF0C\u8FD0\u884C ${SetupCommand} \u51C6\u5907\u3002
`);
    throw new ExitError2(1, "");
  }
  stdout.write("\u524D\u7F6E\u8D44\u6E90\u90FD\u5DF2\u5C31\u7EEA\u3002\n");
}
function setupLogPath(env) {
  return import_node_path25.default.join(import_node_path25.default.dirname(defaultCacheDir(env)), "setup.log");
}
async function setupPrepare(signal, stdout, env, items2, proxy, npmRegistry) {
  const logPath = setupLogPath(env);
  import_node_fs29.default.mkdirSync(import_node_path25.default.dirname(logPath), { recursive: true });
  let logFd;
  try {
    logFd = import_node_fs29.default.openSync(logPath, "w");
  } catch (err) {
    throw new Error(`\u521B\u5EFA\u65E5\u5FD7 ${logPath}\uFF1A${err.message}`);
  }
  const log = { write: (chunk) => import_node_fs29.default.writeSync(logFd, chunk) };
  try {
    const git = { ...env };
    const npm = { ...env };
    if (proxy !== "") git.GIT_CONFIG_PARAMETERS = `'http.proxy'='${proxy}'`;
    if (npmRegistry !== "") npm.npm_config_registry = npmRegistry;
    const mixed = { ...git };
    if (npmRegistry !== "") mixed.npm_config_registry = npmRegistry;
    const run2 = { base: env, git, npm, mixed, log, stage: () => {
    } };
    const view3 = newItemsView(stdout, items2);
    let header = "am setup \xB7 \u51C6\u5907\u524D\u7F6E\u8D44\u6E90";
    if (proxy !== "") header += view3.paint("2", "\uFF08git \u4EE3\u7406 " + proxy + "\uFF09");
    stdout.write(`
${header}

`);
    items2.forEach((item, i) => {
      if (item.ready(env)[0]) view3.markReady(i);
    });
    if (!view3.tty) items2.forEach((_, i) => view3.items[i].state === 2 /* Ready */ && view3.set(i, 2 /* Ready */, ""));
    view3.start();
    const started = Date.now();
    for (const [i, item] of items2.entries()) {
      if (view3.items[i].state === 2 /* Ready */) continue;
      log.write(`
===== ${item.name} ${item.version} =====
`);
      view3.set(i, 1 /* Running */, "\u51C6\u5907\u4E2D");
      run2.stage = (stage) => view3.detail(i, stage);
      try {
        await item.prepare(run2, signal);
      } catch (err) {
        const message = err.message;
        log.write(`
[am] ${message}
`);
        view3.set(i, 4 /* Failed */, "");
        view3.stop();
        import_node_fs29.default.fsyncSync(logFd);
        const body = import_node_fs29.default.readFileSync(logPath, "utf8");
        stdout.write(`
${view3.paint("31", "\u2717")} ${item.name} \u6CA1\u51C6\u5907\u597D\uFF1A${message}
`);
        const cut = body.lastIndexOf("\n[am] ");
        const tail = tailLines(body.slice(0, Math.max(0, cut)).replace(/\n+$/, ""), 12);
        if (tail.length > 0) {
          stdout.write(view3.paint("2", "\n  \u65E5\u5FD7\u6700\u540E\u51E0\u884C\uFF1A") + "\n");
          for (const line2 of tail) stdout.write(view3.paint("2", "  \u2502 " + line2) + "\n");
        }
        stdout.write(`
\u5B8C\u6574\u65E5\u5FD7\uFF1A${homeShort(logPath)}
\u518D\u8FD0\u884C\u4E00\u6B21 am setup \u4F1A\u63A5\u7740\u4E0B\uFF1BGitHub \u6162\u53EF\u4EE5\u52A0 --proxy\u3002
`);
        throw new ExitError2(1, "");
      }
      view3.set(i, 3 /* Done */, "");
    }
    view3.stop();
    stdout.write(`
\u5168\u90E8\u5C31\u7EEA\uFF0C\u7528\u65F6 ${clock(Date.now() - started)}\u3002
`);
  } finally {
    import_node_fs29.default.closeSync(logFd);
  }
}

// src/style_cmd.ts
var import_node_fs30 = __toESM(require("node:fs"), 1);
var import_node_path26 = __toESM(require("node:path"), 1);
function newStyleCommand(stdout) {
  const styleCmd = new Command({
    use: "style",
    short: "\u65E7\u7248\u9879\u76EE\u7684\u5B57\u4F53\u5DE5\u5177",
    long: `\u65E7\u7248\u9879\u76EE\u6216\u9700\u8981\u672C\u5730\u5B57\u4F53\u7684\u955C\u5934\u53EF\u4EE5\u4F7F\u7528\u3002

fonts \u5217\u51FA\u53EF\u7528\u5B57\u4F53\uFF1A\u968F\u6BCF\u4E2A\u9879\u76EE\u4E0B\u53D1\u7684\u6B63\u6587\u5B57\u4F53\uFF0C\u4EE5\u53CA\u5B57\u4F53\u6C60\u91CC\u53EF\u6309\u9700\u62F7\u5165\u7684\u5B57\u4F53\u3002
add-font \u628A\u5B57\u4F53\u6C60\u91CC\u7684\u5B57\u4F53\u8FDE\u540C\u8BB8\u53EF\u8BC1\u62F7\u8FDB\u9879\u76EE\u7684 assets/fonts/\uFF1B\u62F7\u5165\u540E\u8FD8\u8981\u5728
\u955C\u5934\u4EE3\u7801\u901A\u8FC7\u76F8\u5BF9\u8DEF\u5F84\u5F15\u7528\uFF1B\u4E0D\u8981\u4F9D\u8D56\u7CFB\u7EDF\u5B57\u4F53\u3002`
  });
  const fontLine = (font2) => `  ${padRight(font2.family, 32)} ${String(font2.weight).padStart(4)}  ${FontsDir}${font2.file}
`;
  styleCmd.addCommand(
    new Command({
      use: "fonts",
      args: noArgs,
      short: "\u5217\u51FA\u53EF\u7528\u5B57\u4F53",
      long: `\u5217\u51FA\u81EA\u5B9A\u4E49\u98CE\u683C\u53EF\u4EE5\u4F7F\u7528\u7684\u5168\u90E8\u5B57\u4F53\uFF1A\u65CF\u540D\u3001\u5B57\u91CD\u4E0E\u9879\u76EE\u5185\u8DEF\u5F84\u3002

\u7B2C\u4E00\u7EC4\u968F\u6BCF\u4E2A\u9879\u76EE\u4E0B\u53D1\uFF1B\u7B2C\u4E8C\u7EC4\u5728\u5B57\u4F53\u6C60\u91CC\uFF0C\u8981\u5148\u7528 am style add-font \u62F7\u8FDB\u9879\u76EE\u3002
\u4E0D\u5728\u6E05\u5355\u91CC\u7684\u5B57\u4F53\u53EA\u80FD\u7531\u7528\u6237\u81EA\u5E26 woff2 \u6587\u4EF6\uFF0C
\u4E0D\u5F97\u5F15\u7528\u672C\u673A\u7CFB\u7EDF\u5B57\u4F53\u2014\u2014\u6E32\u67D3\u673A\u4E0A\u6CA1\u6709\u3002`,
      example: "  am style fonts",
      runE: () => {
        stdout.write("\u968F\u9879\u76EE\u4E0B\u53D1\uFF08\u65E0\u9700\u62F7\u5165\uFF0C\u53EF\u76F4\u63A5\u58F0\u660E\uFF09\uFF1A\n");
        for (const font2 of SharedFonts) stdout.write(fontLine(font2));
        stdout.write("\u5B57\u4F53\u6C60\uFF08\u7528 am style add-font FAMILY [--weight N] \u62F7\u5165\uFF09\uFF1A\n");
        for (const font2 of allFontsCopy()) stdout.write(fontLine(font2));
      }
    })
  );
  const projectRoot = ref("");
  const weight = ref(0);
  const addCmd = new Command({
    use: "add-font FAMILY",
    args: exactArgs(1, "FAMILY"),
    short: "\u628A\u5B57\u4F53\u6C60\u91CC\u7684\u5B57\u4F53\u62F7\u8FDB\u9879\u76EE",
    long: `\u628A\u5B57\u4F53\u6C60\u91CC FAMILY \u7684\u5B57\u4F53\u6587\u4EF6\u4E0E\u8BB8\u53EF\u8BC1\u62F7\u8FDB assets/fonts/\u3002\u65CF\u540D\u4E0D\u533A\u5206\u5927\u5C0F\u5199\uFF1B
\u4E0D\u4F20 --weight \u65F6\u62F7\u5165\u8BE5\u65CF\u5168\u90E8\u5B57\u91CD\u3002

\u5DF2\u5B58\u5728\u4E14\u5185\u5BB9\u76F8\u540C\u7684\u6587\u4EF6\u8DF3\u8FC7\uFF0C\u5185\u5BB9\u4E0D\u540C\u65F6\u6574\u4F53\u5931\u8D25\u3001\u4E0D\u8986\u76D6\u3002`,
    example: `  am style add-font "LXGW WenKai"
  am style add-font Fredoka --weight 700 --project-root .`,
    runE: (_cmd, args) => {
      const fonts = poolFonts(args[0], weight.value);
      const files2 = fontFiles(fonts);
      const rootDir2 = projectRoot.value || ".";
      let isFile = false;
      try {
        isFile = import_node_fs30.default.statSync(import_node_path26.default.join(rootDir2, "frame.md")).isFile();
      } catch {
        isFile = false;
      }
      if (!isFile) throw new Error(`${rootDir2} \u4E0D\u662F am \u9879\u76EE\uFF08\u7F3A\u5C11 frame.md\uFF09\uFF0C\u7528 --project-root \u6307\u5411\u9879\u76EE\u6839\u76EE\u5F55`);
      const result = initializeWithFiles(rootDir2, files2);
      stdout.write(`\u5DF2\u62F7\u5165 ${fonts[0].family}\uFF08\u65B0\u589E ${result.created}\uFF0C\u672A\u53D8 ${result.unchanged}\uFF09\u3002\u8BF7\u5728\u955C\u5934\u4EE3\u7801\u4E2D\u7528\u76F8\u5BF9\u8DEF\u5F84\u5F15\u7528\uFF1A
`);
      for (const font2 of fonts) stdout.write(`  - {family: ${goQuote(font2.family)}, weight: ${font2.weight}, file: ${goQuote(FontsDir + font2.file)}}
`);
    }
  });
  addCmd.flags().stringVar(projectRoot, "project-root", "", "\u9879\u76EE\u6839\u76EE\u5F55\uFF0C\u7F3A\u7701\u4E3A\u5F53\u524D\u76EE\u5F55");
  addCmd.flags().intVar(weight, "weight", 0, "\u53EA\u62F7\u5165\u6307\u5B9A\u5B57\u91CD\uFF0C\u7F3A\u7701\u4E3A\u8BE5\u65CF\u5168\u90E8\u5B57\u91CD");
  styleCmd.addCommand(addCmd);
  return styleCmd;
}
function poolFonts(family, weight) {
  const matched = [];
  const weights = [];
  for (const font2 of allFontsCopy()) {
    if (font2.family.toLowerCase() !== family.trim().toLowerCase()) continue;
    weights.push(String(font2.weight));
    if (weight === 0 || font2.weight === weight) matched.push(font2);
  }
  if (weights.length === 0) throw new Error(`\u5B57\u4F53\u6C60\u91CC\u6CA1\u6709\u5B57\u4F53\u65CF ${goQuote(family)}\uFF0C\u7528 am style fonts \u67E5\u770B\u53EF\u9009\u5B57\u4F53`);
  if (matched.length === 0) throw new Error(`\u5B57\u4F53\u65CF ${goQuote(family)} \u6CA1\u6709\u5B57\u91CD ${weight}\uFF0C\u53EF\u9009\uFF1A${weights.join(" ")}`);
  return matched;
}

// src/cli.ts
var Version = typeof AM_VERSION === "string" ? AM_VERSION : "dev";
var hyperframesVersion = PinnedVersion;
function currentEnvironment() {
  return envMap();
}
var rootLong = `ArticleToMotion \u7AD6\u5C4F MG \u89C6\u9891\u5236\u4F5C\u5DE5\u5177\u3002

\u628A\u5B9A\u7A3F SRT \u62C6\u6210\u5E76\u53D1\u6E32\u67D3\u7684\u52A8\u753B\u955C\u5934\uFF0C\u6216\u4ECE\u6587\u7AE0/\u53E3\u64AD\u7A3F\u8D70\u5B8C TTS\u3001\u5B57\u5E55\u3001\u5C01\u9762\u3001
\u58F0\u97F3\u4E0E\u53D1\u5E03\u4EA4\u4ED8\u7684\u5168\u6D41\u7A0B\u3002\u6E32\u67D3\u7531\u5916\u90E8 AI CLI \u5B8C\u6210\uFF0Cam \u8D1F\u8D23\u5951\u7EA6\u3001\u8C03\u5EA6\u4E0E\u6821\u9A8C\u3002

\u4E24\u79CD\u5165\u53E3\uFF1A
  am run                          \u6709\u5B9A\u7A3F transcription.srt \u8BFB PROMPT.md\uFF0C\u5426\u5219\u8BFB PROMPT-PRODUCTION.md
  am run PROMPT-PRODUCTION.md     \u4ECE\u6587\u7AE0\u6216\u53E3\u64AD\u7A3F\u5F00\u59CB\u5B8C\u6574\u5236\u4F5C
  am scene run / run-all          \u53EA\u8DD1\u955C\u5934\u6E32\u67D3\uFF0C\u53EF\u8131\u79BB am run \u5355\u72EC\u4F7F\u7528

\u914D\u7F6E\u89E3\u6790\u4F18\u5148\u7EA7\uFF08\u9AD8\u5230\u4F4E\uFF09\uFF1A\u73AF\u5883\u53D8\u91CF > \u9879\u76EE .env > article-to-motion.conf > \u5185\u7F6E\u9ED8\u8BA4\u3002
\u7528 am config get \u8BFB\u53D6\u89E3\u6790\u7ED3\u679C\uFF0C\u4E0D\u8981\u81EA\u5DF1\u89E3\u6790\u914D\u7F6E\u6587\u4EF6\u3002
\u9879\u76EE .env \u4E0D\u5141\u8BB8\u51FA\u73B0\u4EE5 API_KEY / TOKEN / SECRET / PASSWORD \u7ED3\u5C3E\u7684\u952E\uFF0C\u51FA\u73B0\u5219\u62D2\u7EDD\u542F\u52A8\u3002

\u5916\u90E8 AI CLI \u9ED8\u8BA4\u8FD0\u884C\u5728\u9650\u5236\u4E8E\u9879\u76EE\u5DE5\u4F5C\u533A\u7684\u5B89\u5168\u6A21\u5F0F\u3002\u5B89\u5168\u6A21\u5F0F\u4E0B\u5B50\u8FDB\u7A0B\u53EA\u7EE7\u627F\u767D\u540D\u5355
\u73AF\u5883\u53D8\u91CF\u52A0\u4E0A .env \u8986\u76D6\u5C42\uFF1B\u7F3A\u53D8\u91CF\u7528 AM_PASSTHROUGH_ENV=NAME1,NAME2 \u663E\u5F0F\u5217\u51FA\uFF0C
\u4E0D\u8981\u6539\u7528 --unsafe \u7ED5\u8FC7\u9694\u79BB\u3002

\u9000\u51FA\u7801\uFF1A
  0    \u6210\u529F
  1    \u4E00\u822C\u5931\u8D25\uFF08\u53C2\u6570\u3001\u6821\u9A8C\u3001\u914D\u7F6E\u3001IO\uFF09
  127  \u7F3A\u5C11\u5FC5\u9700\u7684\u5916\u90E8\u547D\u4EE4
  130  \u88AB\u4E2D\u65AD\uFF08SIGINT / \u4E0A\u4E0B\u6587\u53D6\u6D88\uFF09
  \u5176\u4ED6 \u900F\u4F20\u5B50\u8FDB\u7A0B\u9000\u51FA\u7801\uFF1Aam run \u7528\u7F16\u6392\u5DE5\u5177\u7684\u9000\u51FA\u7801\uFF0Cam scene run-all \u7528\u955C\u5934\u6C47\u603B\u9000\u51FA\u7801

\u6240\u6709\u9519\u8BEF\u5199 stderr\uFF0C\u6B63\u5E38\u8F93\u51FA\u5199 stdout\uFF1B\u5931\u8D25\u65F6\u4E0D\u6253\u5370 usage\uFF0C\u53EA\u6253\u5370\u4E00\u884C\u9519\u8BEF\u3002`;
function newRoot(stdout, stderr) {
  const unsafe = ref(false);
  const root = new Command({ use: "am", short: "ArticleToMotion \u7AD6\u5C4F MG \u89C6\u9891\u5236\u4F5C\u5DE5\u5177", long: rootLong, version: Version });
  root.setOut(stdout);
  root.setErr(stderr);
  root.persistentFlags().boolVar(
    unsafe,
    "unsafe",
    false,
    "\u5173\u95ED AI CLI \u7684\u6743\u9650\u9694\u79BB\uFF08\u5371\u9669\uFF09\u3002\u53EA\u5BF9\u4F1A\u542F\u52A8 AI CLI \u7684 run / studio / scene run / scene run-all \u751F\u6548\uFF0C\u5BF9 init\u3001config\u3001validate\u3001archive \u65E0\u4F5C\u7528\uFF1B\u4F1A\u4F20\u9012\u7ED9\u5D4C\u5957\u955C\u5934\u4EFB\u52A1"
  );
  const flags = { unsafe };
  root.addCommand(newSetupCommand(stdout, stderr), newHyperframesCommand(stdout, stderr), newFilmStyleCommand(stdout, stderr));
  root.addCommand(newInitCommand(stdout, stderr), newConfigCommand(stdout), newArchiveCommand(stdout), newAlignCommand(stdout), newAudioCommand(stdout), newStyleCommand(stdout));
  return { root, flags };
}
async function execute3(args, stdout, stderr, signal) {
  const { root } = newRoot(stdout, stderr);
  if (signal) root.setContext(signal);
  try {
    await root.execute(args);
    return 0;
  } catch (err) {
    if (!(err instanceof ExitError2) || err.bare !== "") stderr.write(String(err?.message ?? err) + "\n");
    if (err instanceof ExitError2) return err.code;
    if (signal?.aborted) return 130;
    if (String(err?.message ?? "").includes(MissingToolPrefix)) return 127;
    return 1;
  }
}
function exactArgs(count, name) {
  return (cmd, args) => {
    if (args.length !== count) throw new Error(`${cmd.commandPath()} \u9700\u8981 ${count} \u4E2A\u4F4D\u7F6E\u53C2\u6570 ${name}\uFF0C\u5B9E\u9645\u6536\u5230 ${args.length} \u4E2A\uFF1B\u7528\u6CD5\uFF1A${cmd.useLine()}`);
  };
}
function maxArgs(count, name) {
  return (cmd, args) => {
    if (args.length > count) throw new Error(`${cmd.commandPath()} \u6700\u591A\u63A5\u53D7 ${count} \u4E2A\u4F4D\u7F6E\u53C2\u6570 ${name}\uFF0C\u5B9E\u9645\u6536\u5230 ${args.length} \u4E2A\uFF1B\u7528\u6CD5\uFF1A${cmd.useLine()}`);
  };
}
var noArgs = (cmd, args) => {
  if (args.length > 0) throw new Error(`${cmd.commandPath()} \u4E0D\u63A5\u53D7\u4F4D\u7F6E\u53C2\u6570\uFF0C\u5B9E\u9645\u6536\u5230 ${args.length} \u4E2A\uFF1A${args.join(" ")}\uFF1B\u7528\u6CD5\uFF1A${cmd.useLine()}`);
};
function skillsProgressPrinter(w) {
  let last = "";
  return (p) => {
    let line2 = `HyperFrames\uFF1A${p.stage}`;
    if (!p.indeterminate) line2 += ` ${formatFixed(p.percent, 0).padStart(3)}%`;
    if (line2 === last) return;
    last = line2;
    w.write(`\r\x1B[K${line2}`);
    if (p.percent >= 100) w.write("\n");
  };
}

// src/main.ts
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (err) => {
    if (err.code === "EPIPE") process.exit(141);
    throw err;
  });
}
var controller = new AbortController();
var interrupted = false;
process.on("SIGINT", () => {
  if (interrupted) process.exit(130);
  interrupted = true;
  controller.abort();
});
execute3(process.argv.slice(2), process.stdout, process.stderr, controller.signal).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(String(err?.stack ?? err) + "\n");
    process.exitCode = 1;
  }
);
