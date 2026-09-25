/*
 * Slinger script prelude: the Postman-compatible `pm` API, evaluated inside the QuickJS sandbox before every
 * user script (each script gets a fresh runtime + context, so nothing here or in a script leaks into the next).
 *
 * The only bridge to the host is `__slinger_call(op, argsJson) -> resultJson` (strings in, strings out). This
 * file captures it in a closure and deletes the global, so user code can only reach the host through `pm`.
 * Loaded as text (see sandbox.ts); plain ES2020, no imports.
 */
;(function (call) {
  'use strict'
  var G = globalThis
  var stringify = JSON.stringify
  var parse = JSON.parse
  var hasOwn = Object.prototype.hasOwnProperty
  var objToString = Object.prototype.toString
  var keysOf = Object.keys
  var defineProperty = Object.defineProperty
  var isArray = Array.isArray

  function host(op, args) {
    var r = parse(call(op, stringify(args || [])))
    if (r.e !== undefined) throw new Error(r.e)
    return r.v
  }

  var INIT = host('init')
  var EVENT = INIT.event

  // -------------------------------------------------------------------------
  // Formatting (console and assertion messages)
  // -------------------------------------------------------------------------

  function typeOf(v) {
    if (v === null) return 'null'
    if (isArray(v)) return 'array'
    var t = typeof v
    if (t !== 'object') return t
    var tag = objToString.call(v).slice(8, -1).toLowerCase()
    return tag === 'object' ? 'object' : tag
  }

  function inspect(v, depth, seen) {
    depth = depth || 0
    seen = seen || []
    var t = typeOf(v)
    if (t === 'string') return depth === 0 ? v : "'" + v + "'"
    if (t === 'number' || t === 'boolean' || t === 'undefined' || t === 'null' || t === 'bigint' || t === 'symbol') return String(v)
    if (t === 'function') return '[Function' + (v.name ? ': ' + v.name : '') + ']'
    if (t === 'date') return isNaN(v.getTime()) ? 'Invalid Date' : v.toISOString()
    if (t === 'regexp') return String(v)
    if (t === 'error') return (v.name || 'Error') + ': ' + v.message
    if (seen.indexOf(v) >= 0) return '[Circular]'
    if (depth > 4) return t === 'array' ? '[Array]' : '[Object]'
    seen = seen.concat([v])
    if (t === 'array') {
      var items = []
      for (var i = 0; i < v.length && i < 100; i++) items.push(inspect(v[i], depth + 1, seen))
      if (v.length > 100) items.push('... ' + (v.length - 100) + ' more items')
      return '[ ' + items.join(', ') + ' ]'
    }
    var ks = keysOf(v)
    var parts = []
    for (var j = 0; j < ks.length && j < 100; j++) {
      var k = ks[j]
      var key = /^[A-Za-z_$][\w$]*$/.test(k) ? k : "'" + k + "'"
      parts.push(key + ': ' + inspect(v[k], depth + 1, seen))
    }
    if (ks.length > 100) parts.push('... ' + (ks.length - 100) + ' more keys')
    return parts.length ? '{ ' + parts.join(', ') + ' }' : '{}'
  }

  function format(args) {
    var list = Array.prototype.slice.call(args)
    var out = []
    if (typeof list[0] === 'string' && /%[sdifjoOc%]/.test(list[0])) {
      var rest = list.slice(1)
      var first = list.shift().replace(/%([sdifjoOc%])/g, function (m, f) {
        if (f === '%') return '%'
        if (!rest.length) return m
        list.shift()
        var a = rest.shift()
        switch (f) {
          case 's': return typeof a === 'string' ? a : inspect(a, 1)
          case 'd':
          case 'i': return String(f === 'i' ? parseInt(a, 10) : Number(a))
          case 'f': return String(parseFloat(a))
          case 'j': try { return stringify(a) } catch (e) { return '[Circular]' }
          case 'c': return ''
          default: return inspect(a, 1)
        }
      })
      out.push(first)
    }
    for (var i = 0; i < list.length; i++) out.push(inspect(list[i]))
    return out.join(' ')
  }

  function logger(level) {
    return function () {
      host('console', [level, format(arguments)])
    }
  }
  var consoleObj = {
    log: logger('log'),
    info: logger('info'),
    warn: logger('warn'),
    error: logger('error'),
    debug: logger('log'),
    trace: logger('log'),
  }

  // -------------------------------------------------------------------------
  // Deep equality and paths
  // -------------------------------------------------------------------------

  function deepEqual(a, b, depth) {
    depth = depth || 0
    if (depth > 100) return false
    if (a === b) return a !== 0 || 1 / a === 1 / b
    if (a !== a && b !== b) return true // NaN
    var ta = typeOf(a)
    if (ta !== typeOf(b)) return false
    if (ta === 'date') return a.getTime() === b.getTime()
    if (ta === 'regexp') return String(a) === String(b)
    if (ta === 'array') {
      if (a.length !== b.length) return false
      for (var i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i], depth + 1)) return false
      return true
    }
    if (ta === 'object' || ta === 'error' || ta === 'arguments') {
      var ka = keysOf(a).sort()
      var kb = keysOf(b).sort()
      if (ka.length !== kb.length) return false
      for (var j = 0; j < ka.length; j++) {
        if (ka[j] !== kb[j]) return false
        if (!deepEqual(a[ka[j]], b[kb[j]], depth + 1)) return false
      }
      return true
    }
    return false
  }

  /** "a.b[0].c" -> ["a", "b", "0", "c"] */
  function pathParts(path) {
    if (isArray(path)) return path.map(String)
    return String(path).replace(/\[(\w+)\]/g, '.$1').replace(/^\./, '').split('.')
  }

  function getPath(obj, path) {
    var parts = pathParts(path)
    var cur = obj
    for (var i = 0; i < parts.length; i++) {
      if (cur === null || cur === undefined) return { exists: false }
      var o = Object(cur)
      if (!(parts[i] in o)) return { exists: false }
      cur = o[parts[i]]
    }
    return { exists: true, value: cur }
  }

  // -------------------------------------------------------------------------
  // Assertions (a chai-like subset: expect/should-style chains)
  // -------------------------------------------------------------------------

  function AssertionError(message) {
    this.message = message
    this.name = 'AssertionError'
  }
  AssertionError.prototype = Object.create(Error.prototype)
  AssertionError.prototype.constructor = AssertionError
  AssertionError.prototype.name = 'AssertionError'

  function isResponse(v) {
    return v !== null && typeof v === 'object' && v.__slingerResponse === true
  }

  function Assertion(obj, message, flags) {
    this._obj = obj
    this._msg = message
    this._flags = flags || {}
  }
  var AP = Assertion.prototype

  function show(v) {
    if (isResponse(v)) return 'response'
    return inspect(v, 1)
  }

  AP._assert = function (ok, msg, negatedMsg) {
    var negate = !!this._flags.negate
    if (negate ? ok : !ok) {
      var m = negate ? negatedMsg : msg
      throw new AssertionError((this._msg ? this._msg + ': ' : '') + m)
    }
    return this
  }

  var CHAIN_WORDS = ['to', 'be', 'been', 'is', 'that', 'which', 'and', 'has', 'have', 'with', 'at', 'of', 'same', 'but', 'does', 'still', 'also']
  CHAIN_WORDS.forEach(function (w) {
    defineProperty(AP, w, { get: function () { return this }, configurable: true })
  })

  function flagGetter(name, flag) {
    defineProperty(AP, name, {
      get: function () {
        if (flag === 'negate') this._flags.negate = !this._flags.negate
        else this._flags[flag] = true
        return this
      },
      configurable: true,
    })
  }
  flagGetter('not', 'negate')
  flagGetter('deep', 'deep')
  flagGetter('nested', 'nested')
  flagGetter('own', 'own')
  flagGetter('any', 'any')
  flagGetter('all', 'all')

  function method(names, fn) {
    names.forEach(function (n) {
      defineProperty(AP, n, { value: fn, writable: true, configurable: true })
    })
  }

  /** A method that can also be used as a chain property (`.include.members`, `.contain.keys`). */
  function chainable(names, fn, flag) {
    names.forEach(function (n) {
      defineProperty(AP, n, {
        get: function () {
          var self = this
          self._flags[flag] = true
          var f = function () {
            return fn.apply(self, arguments)
          }
          Object.setPrototypeOf(f, self)
          return f
        },
        configurable: true,
      })
    })
  }

  function propGetter(names, fn) {
    names.forEach(function (n) {
      defineProperty(AP, n, { get: fn, configurable: true })
    })
  }

  method(['equal', 'equals', 'eq'], function (expected) {
    var obj = this._obj
    var ok = this._flags.deep ? deepEqual(obj, expected) : obj === expected || (obj !== obj && expected !== expected)
    var word = this._flags.deep ? 'deeply equal ' : 'equal '
    return this._assert(ok, 'expected ' + show(obj) + ' to ' + word + show(expected), 'expected ' + show(obj) + ' to not ' + word + show(expected))
  })
  method(['eql', 'eqls'], function (expected) {
    return this._assert(deepEqual(this._obj, expected), 'expected ' + show(this._obj) + ' to deeply equal ' + show(expected), 'expected ' + show(this._obj) + ' to not deeply equal ' + show(expected))
  })
  method(['a', 'an'], function (type) {
    var t = String(type).toLowerCase()
    var actual = typeOf(this._obj)
    var article = /^[aeiou]/.test(t) ? 'an ' : 'a '
    return this._assert(actual === t, 'expected ' + show(this._obj) + ' to be ' + article + t, 'expected ' + show(this._obj) + ' not to be ' + article + t)
  })

  function includes(obj, val, deep) {
    var t = typeOf(obj)
    if (t === 'string') return obj.indexOf(String(val)) >= 0
    if (t === 'array') {
      for (var i = 0; i < obj.length; i++) if (deep ? deepEqual(obj[i], val) : obj[i] === val) return true
      return false
    }
    if (t === 'set' || t === 'map') return obj.has(val)
    if (t === 'object') {
      if (val !== null && typeof val === 'object') {
        var ks = keysOf(val)
        for (var j = 0; j < ks.length; j++) {
          if (!(ks[j] in obj)) return false
          if (deep ? !deepEqual(obj[ks[j]], val[ks[j]]) : obj[ks[j]] !== val[ks[j]]) return false
        }
        return true
      }
      return false
    }
    throw new AssertionError('the given combination of arguments (' + t + ' and ' + typeOf(val) + ') is invalid for this assertion')
  }
  chainable(['include', 'includes', 'contain', 'contains'], function (val) {
    return this._assert(includes(this._obj, val, this._flags.deep), 'expected ' + show(this._obj) + ' to include ' + show(val), 'expected ' + show(this._obj) + ' to not include ' + show(val))
  }, 'contains')

  function propertyAssert(name, args, own) {
    var obj = this._obj
    var desc = this._flags.nested ? 'nested property ' : own || this._flags.own ? 'own property ' : 'property '
    var exists
    var value
    if (this._flags.nested) {
      var r = getPath(obj, name)
      exists = r.exists
      value = r.value
    } else if (obj === null || obj === undefined) {
      exists = false
    } else if (own || this._flags.own) {
      exists = hasOwn.call(Object(obj), name)
      value = exists ? obj[name] : undefined
    } else {
      exists = name in Object(obj)
      value = exists ? obj[name] : undefined
    }
    if (args.length > 1) {
      var expected = args[1]
      var same = this._flags.deep ? deepEqual(value, expected) : value === expected
      this._assert(exists && same,
        'expected ' + show(obj) + ' to have ' + desc + "'" + name + "' of " + show(expected) + (exists ? ', but got ' + show(value) : ''),
        'expected ' + show(obj) + ' to not have ' + desc + "'" + name + "' of " + show(expected))
    } else {
      this._assert(exists, 'expected ' + show(obj) + ' to have ' + desc + "'" + name + "'", 'expected ' + show(obj) + ' to not have ' + desc + "'" + name + "'")
    }
    if (!this._flags.negate) this._obj = value
    return this
  }
  method(['property'], function (name) {
    return propertyAssert.call(this, name, arguments, false)
  })
  method(['ownProperty', 'haveOwnProperty'], function (name) {
    return propertyAssert.call(this, name, arguments, true)
  })

  method(['oneOf'], function (list) {
    var obj = this._obj
    var deep = this._flags.deep
    var ok = isArray(list) && list.some(function (x) { return deep ? deepEqual(x, obj) : x === obj })
    return this._assert(ok, 'expected ' + show(obj) + ' to be one of ' + show(list), 'expected ' + show(obj) + ' to not be one of ' + show(list))
  })

  function sizeOf(obj) {
    if (obj === null || obj === undefined) throw new AssertionError('expected ' + show(obj) + ' to have a length')
    if (typeOf(obj) === 'map' || typeOf(obj) === 'set') return obj.size
    return obj.length
  }
  function compare(names, op, word) {
    method(names, function (n) {
      var subject = this._flags.lengthOf ? sizeOf(this._obj) : this._obj
      if (typeof subject !== 'number' && !(this._obj instanceof Date)) {
        throw new AssertionError('expected ' + show(this._obj) + ' to be a number or a date')
      }
      var label = this._flags.lengthOf ? show(this._obj) + ' to have a length ' : show(subject) + ' to be '
      return this._assert(op(subject, n), 'expected ' + label + word + ' ' + show(n), 'expected ' + label.replace(' to ', ' to not ') + word + ' ' + show(n))
    })
  }
  compare(['above', 'gt', 'greaterThan'], function (a, b) { return a > b }, 'above')
  compare(['below', 'lt', 'lessThan'], function (a, b) { return a < b }, 'below')
  compare(['least', 'gte', 'greaterThanOrEqual'], function (a, b) { return a >= b }, 'at least')
  compare(['most', 'lte', 'lessThanOrEqual'], function (a, b) { return a <= b }, 'at most')
  method(['within'], function (lo, hi) {
    var v = this._flags.lengthOf ? sizeOf(this._obj) : this._obj
    return this._assert(v >= lo && v <= hi, 'expected ' + show(v) + ' to be within ' + lo + '..' + hi, 'expected ' + show(v) + ' to not be within ' + lo + '..' + hi)
  })
  method(['closeTo', 'approximately'], function (expected, delta) {
    return this._assert(Math.abs(this._obj - expected) <= delta, 'expected ' + show(this._obj) + ' to be close to ' + expected + ' +/- ' + delta, 'expected ' + show(this._obj) + ' not to be close to ' + expected + ' +/- ' + delta)
  })
  // `.lengthOf(3)` asserts; `.lengthOf.above(2)` compares the length (chainable).
  chainable(['length', 'lengthOf'], function (n) {
    var len = sizeOf(this._obj)
    return this._assert(len === n, 'expected ' + show(this._obj) + ' to have a length of ' + n + ' but got ' + len, 'expected ' + show(this._obj) + ' to not have a length of ' + n)
  }, 'lengthOf')
  method(['match', 'matches'], function (re) {
    return this._assert(re.test(String(this._obj)), 'expected ' + show(this._obj) + ' to match ' + re, 'expected ' + show(this._obj) + ' not to match ' + re)
  })
  method(['string'], function (sub) {
    return this._assert(String(this._obj).indexOf(sub) >= 0, 'expected ' + show(this._obj) + ' to contain ' + show(sub), 'expected ' + show(this._obj) + ' to not contain ' + show(sub))
  })
  method(['keys', 'key'], function () {
    var want = isArray(arguments[0]) ? arguments[0] : typeOf(arguments[0]) === 'object' ? keysOf(arguments[0]) : Array.prototype.slice.call(arguments)
    var obj = Object(this._obj)
    var have = keysOf(obj)
    var ok
    if (this._flags.any) ok = want.some(function (k) { return have.indexOf(String(k)) >= 0 })
    else {
      var all = want.every(function (k) { return have.indexOf(String(k)) >= 0 })
      ok = this._flags.contains ? all : all && have.length === want.length
    }
    return this._assert(ok, 'expected ' + show(this._obj) + ' to have ' + (this._flags.any ? 'any of ' : '') + 'keys ' + show(want), 'expected ' + show(this._obj) + ' to not have ' + (this._flags.any ? 'any of ' : '') + 'keys ' + show(want))
  })
  method(['members'], function (list) {
    var obj = this._obj
    var deep = this._flags.deep
    var has = function (arr, x) { return arr.some(function (y) { return deep ? deepEqual(x, y) : x === y }) }
    var subset = list.every(function (x) { return has(obj, x) })
    var ok = this._flags.contains ? subset : subset && obj.length === list.length && obj.every(function (x) { return has(list, x) })
    return this._assert(ok, 'expected ' + show(obj) + ' to have the same members as ' + show(list), 'expected ' + show(obj) + ' to not have the same members as ' + show(list))
  })
  method(['instanceOf', 'instanceof'], function (ctor) {
    return this._assert(this._obj instanceof ctor, 'expected ' + show(this._obj) + ' to be an instance of ' + (ctor && ctor.name), 'expected ' + show(this._obj) + ' to not be an instance of ' + (ctor && ctor.name))
  })
  method(['satisfy', 'satisfies'], function (fn) {
    return this._assert(!!fn(this._obj), 'expected ' + show(this._obj) + ' to satisfy the given function', 'expected ' + show(this._obj) + ' to not satisfy the given function')
  })
  method(['throw', 'throws', 'Throw'], function (expected) {
    var threw = false
    var err
    try {
      this._obj()
    } catch (e) {
      threw = true
      err = e
    }
    var ok = threw
    if (threw && expected !== undefined) {
      var msg = err && err.message !== undefined ? String(err.message) : String(err)
      if (typeof expected === 'string') ok = msg.indexOf(expected) >= 0
      else if (typeOf(expected) === 'regexp') ok = expected.test(msg)
      else if (typeof expected === 'function') ok = err instanceof expected
    }
    return this._assert(ok, 'expected function to throw' + (expected !== undefined ? ' ' + show(expected) : ''), 'expected function to not throw' + (expected !== undefined ? ' ' + show(expected) : ''))
  })

  function simpleGetter(names, test, what) {
    propGetter(names, function () {
      return this._assert(test(this._obj), 'expected ' + show(this._obj) + ' to be ' + what, 'expected ' + show(this._obj) + ' to not be ' + what)
    })
  }
  simpleGetter(['true'], function (v) { return v === true }, 'true')
  simpleGetter(['false'], function (v) { return v === false }, 'false')
  simpleGetter(['null'], function (v) { return v === null }, 'null')
  simpleGetter(['undefined'], function (v) { return v === undefined }, 'undefined')
  simpleGetter(['NaN'], function (v) { return v !== v }, 'NaN')
  simpleGetter(['finite'], function (v) { return typeof v === 'number' && isFinite(v) }, 'a finite number')
  propGetter(['exist', 'exists'], function () {
    var v = this._obj
    return this._assert(v !== null && v !== undefined, 'expected ' + show(v) + ' to exist', 'expected ' + show(v) + ' to not exist')
  })
  propGetter(['empty'], function () {
    var v = this._obj
    var t = typeOf(v)
    var len = t === 'string' || t === 'array' ? v.length : t === 'map' || t === 'set' ? v.size : t === 'object' ? keysOf(v).length : -1
    if (len < 0) throw new AssertionError('.empty was passed non-string primitive ' + show(v))
    return this._assert(len === 0, 'expected ' + show(v) + ' to be empty', 'expected ' + show(v) + ' not to be empty')
  })

  // ---- response assertions (pm.response.to... / pm.expect(pm.response)...) ----

  function statusRange(names, lo, hi, what) {
    propGetter(names, function () {
      var v = this._obj
      if (!isResponse(v)) {
        if (names[0] === 'ok') return this._assert(!!v, 'expected ' + show(v) + ' to be truthy', 'expected ' + show(v) + ' to be falsy')
        throw new AssertionError('.' + names[0] + ' can only be used on pm.response')
      }
      return this._assert(v.code >= lo && v.code <= hi, 'expected response code to be ' + what + ' but found ' + v.code, 'expected response code to not be ' + what + ' but found ' + v.code)
    })
  }
  statusRange(['ok', 'success'], 200, 299, '2XX')
  statusRange(['info'], 100, 199, '1XX')
  statusRange(['redirection'], 300, 399, '3XX')
  statusRange(['clientError'], 400, 499, '4XX')
  statusRange(['serverError'], 500, 599, '5XX')
  statusRange(['error'], 400, 599, '4XX or 5XX')
  statusRange(['accepted'], 202, 202, '202')
  statusRange(['badRequest'], 400, 400, '400')
  statusRange(['unauthorized', 'unauthorised'], 401, 401, '401')
  statusRange(['forbidden'], 403, 403, '403')
  statusRange(['notFound'], 404, 404, '404')
  statusRange(['rateLimited'], 429, 429, '429')

  function needResponse(a, what) {
    if (!isResponse(a._obj)) throw new AssertionError('.' + what + '() can only be used on pm.response')
    return a._obj
  }
  method(['status'], function (expected) {
    var r = needResponse(this, 'status')
    if (typeof expected === 'string') {
      return this._assert(r.status === expected, "expected response to have status reason '" + expected + "' but got '" + r.status + "'", "expected response to not have status reason '" + expected + "'")
    }
    return this._assert(r.code === expected, 'expected response to have status code ' + expected + ' but got ' + r.code, 'expected response to not have status code ' + expected)
  })
  method(['header'], function (name, value) {
    var r = needResponse(this, 'header')
    var has = r.headers.has(name)
    if (arguments.length < 2) return this._assert(has, "expected response to have header '" + name + "'", "expected response to not have header '" + name + "'")
    var actual = r.headers.get(name)
    return this._assert(has && actual === value, "expected '" + name + "' response header to be '" + value + "' but got '" + actual + "'", "expected '" + name + "' response header to not be '" + value + "'")
  })
  method(['body'], function (expected) {
    var r = needResponse(this, 'body')
    var text = r.text()
    if (arguments.length === 0) return this._assert(text.length > 0, 'expected response to have a body', 'expected response to not have a body')
    if (typeOf(expected) === 'regexp') return this._assert(expected.test(text), 'expected response body to match ' + expected, 'expected response body to not match ' + expected)
    if (typeof expected === 'string') return this._assert(text === expected, 'expected response body to equal ' + show(expected), 'expected response body to not equal ' + show(expected))
    var json
    try { json = parse(text) } catch (e) { return this._assert(false, 'expected response body to be valid JSON', 'expected response body to not be valid JSON') }
    return this._assert(deepEqual(json, expected), 'expected response body to deeply equal ' + show(expected), 'expected response body to not deeply equal ' + show(expected))
  })
  method(['jsonBody'], function (path, value) {
    var r = needResponse(this, 'jsonBody')
    var json
    var valid = true
    try { json = parse(r.text()) } catch (e) { valid = false }
    if (arguments.length === 0 || !valid) return this._assert(valid, 'expected response body to be a valid json', 'expected response body to not be a valid json')
    if (typeOf(path) === 'object' && arguments.length === 1) return this._assert(deepEqual(json, path), 'expected response json to deeply equal ' + show(path), 'expected response json to not deeply equal ' + show(path))
    var got = getPath(json, path)
    if (arguments.length === 1) return this._assert(got.exists, "expected response json to have path '" + path + "'", "expected response json to not have path '" + path + "'")
    return this._assert(got.exists && deepEqual(got.value, value), "expected response json at '" + path + "' to be " + show(value) + (got.exists ? ' but got ' + show(got.value) : ''), "expected response json at '" + path + "' to not be " + show(value))
  })
  propGetter(['json'], function () {
    var r = needResponse(this, 'json')
    var ok = true
    try { parse(r.text()) } catch (e) { ok = false }
    return this._assert(ok, 'expected response body to be a valid json', 'expected response body to not be a valid json')
  })
  propGetter(['withBody'], function () {
    var r = needResponse(this, 'withBody')
    return this._assert(r.text().length > 0, 'expected response to have content in body', 'expected response to not have content in body')
  })

  function expect(value, message) {
    return new Assertion(value, message)
  }
  expect.fail = function (message) {
    throw new AssertionError(message || 'expect.fail()')
  }

  // -------------------------------------------------------------------------
  // Property lists (headers, query params)
  // -------------------------------------------------------------------------

  function toKv(item) {
    if (typeof item === 'string') {
      var i = item.indexOf(':')
      return { key: (i >= 0 ? item.slice(0, i) : item).trim(), value: i >= 0 ? item.slice(i + 1).trim() : '' }
    }
    if (!item || typeof item !== 'object') throw new TypeError('expected an object like { key, value }')
    var out = { key: String(item.key === undefined ? '' : item.key), value: item.value === undefined || item.value === null ? '' : typeof item.value === 'string' ? item.value : stringify(item.value) }
    if (item.disabled) out.disabled = true
    return out
  }

  function PropertyList(items, onChange, caseInsensitive) {
    this._items = items
    this._onChange = onChange
    this._ci = !!caseInsensitive
  }
  var PL = PropertyList.prototype
  PL._same = function (a, b) {
    return this._ci ? String(a).toLowerCase() === String(b).toLowerCase() : String(a) === String(b)
  }
  PL._live = function () {
    return this._items.filter(function (i) { return !i.disabled })
  }
  PL._changed = function () {
    if (!this._onChange) throw new TypeError('this list is read-only')
    this._onChange()
  }
  PL.get = function (key) {
    var self = this
    var found = this._live().filter(function (i) { return self._same(i.key, key) })
    return found.length ? found[found.length - 1].value : undefined
  }
  PL.one = function (key) {
    var self = this
    return this._live().filter(function (i) { return self._same(i.key, key) })[0]
  }
  PL.has = function (key, value) {
    var self = this
    return this._live().some(function (i) { return self._same(i.key, key) && (value === undefined || i.value === value) })
  }
  PL.all = function () {
    return this._items.map(function (i) { var o = { key: i.key, value: i.value }; if (i.disabled) o.disabled = true; return o })
  }
  PL.toObject = function () {
    var out = {}
    this._live().forEach(function (i) { out[i.key] = i.value })
    return out
  }
  PL.toJSON = PL.all
  PL.count = function () {
    return this._items.length
  }
  PL.idx = function (n) {
    return this.all()[n]
  }
  PL.each = function (fn) {
    this.all().forEach(fn)
  }
  PL.map = function (fn) {
    return this.all().map(fn)
  }
  PL.filter = function (fn) {
    return this.all().filter(fn)
  }
  PL.find = function (fn) {
    return this.all().find(fn)
  }
  PL.toString = function () {
    return this._live().map(function (i) { return i.key + ': ' + i.value }).join('\n')
  }
  PL.add = function (item) {
    this._items.push(toKv(item))
    this._changed()
  }
  PL.append = PL.add
  PL.upsert = function (item) {
    var kv = toKv(item)
    var self = this
    var existing = this._items.filter(function (i) { return self._same(i.key, kv.key) })
    if (existing.length) {
      existing[0].value = kv.value
      delete existing[0].disabled
    } else this._items.push(kv)
    this._changed()
  }
  PL.remove = function (predicate) {
    var self = this
    var keep = this._items.filter(function (i) {
      if (typeof predicate === 'function') return !predicate(i)
      if (predicate && typeof predicate === 'object') return !self._same(i.key, predicate.key)
      return !self._same(i.key, predicate)
    })
    this._items.length = 0
    Array.prototype.push.apply(this._items, keep)
    this._changed()
  }
  PL.clear = function () {
    this._items.length = 0
    this._changed()
  }
  PL.populate = function (list) {
    this._items.length = 0
    var items = this._items
    ;(list || []).forEach(function (i) { items.push(toKv(i)) })
    this._changed()
  }

  // -------------------------------------------------------------------------
  // pm.request
  // -------------------------------------------------------------------------

  var reqData = INIT.request
  function syncRequest() {
    host('request.set', [reqData])
  }

  function splitUrl(raw) {
    var rest = String(raw)
    var hash = ''
    var h = rest.indexOf('#')
    if (h >= 0) { hash = rest.slice(h + 1); rest = rest.slice(0, h) }
    var query = null
    var q = rest.indexOf('?')
    if (q >= 0) { query = rest.slice(q + 1); rest = rest.slice(0, q) }
    return { base: rest, query: query, hash: hash }
  }
  function parseQuery(query) {
    if (!query) return []
    return query.split('&').filter(function (p) { return p !== '' }).map(function (p) {
      var i = p.indexOf('=')
      return i >= 0 ? { key: p.slice(0, i), value: p.slice(i + 1) } : { key: p, value: '' }
    })
  }

  var queryItems = parseQuery(splitUrl(reqData.url).query)
  function rebuildUrlFromQuery() {
    var parts = splitUrl(reqData.url)
    var live = queryItems.filter(function (i) { return !i.disabled })
    var q = live.map(function (i) { return i.value === '' && i.key !== '' ? i.key + '=' : i.key + '=' + i.value }).join('&')
    reqData.url = parts.base + (q ? '?' + q : '') + (parts.hash ? '#' + parts.hash : '')
    syncRequest()
  }
  var queryList = new PropertyList(queryItems, rebuildUrlFromQuery, false)

  function setUrl(v) {
    reqData.url = String(v)
    var fresh = parseQuery(splitUrl(reqData.url).query)
    queryItems.length = 0
    Array.prototype.push.apply(queryItems, fresh)
    syncRequest()
  }

  var url = {
    toString: function () { return reqData.url },
    toJSON: function () { return reqData.url },
    update: setUrl,
    getRaw: function () { return reqData.url },
    getHost: function () {
      var base = splitUrl(reqData.url).base.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '')
      var host = base.split('/')[0]
      var at = host.lastIndexOf('@')
      if (at >= 0) host = host.slice(at + 1)
      return host.replace(/:\d+$/, '')
    },
    getPath: function () {
      var base = splitUrl(reqData.url).base.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '')
      var i = base.indexOf('/')
      return i >= 0 ? base.slice(i) : '/'
    },
    getQueryString: function () {
      return splitUrl(reqData.url).query || ''
    },
    addQueryParams: function (params) {
      ;(isArray(params) ? params : [params]).forEach(function (p) { queryItems.push(typeof p === 'string' ? parseQuery(p)[0] : toKv(p)) })
      rebuildUrlFromQuery()
    },
    removeQueryParams: function (keys) {
      var list = isArray(keys) ? keys.map(String) : [String(keys)]
      var keep = queryItems.filter(function (i) { return list.indexOf(i.key) < 0 })
      queryItems.length = 0
      Array.prototype.push.apply(queryItems, keep)
      rebuildUrlFromQuery()
    },
  }
  defineProperty(url, 'query', { get: function () { return queryList }, enumerable: true })
  defineProperty(url, 'protocol', { get: function () { var m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(reqData.url); return m ? m[1] : undefined }, enumerable: true })
  defineProperty(url, 'host', { get: function () { return url.getHost().split('.') }, enumerable: true })
  defineProperty(url, 'path', { get: function () { return url.getPath().split('/').filter(function (p) { return p !== '' }) }, enumerable: true })
  defineProperty(url, 'hash', { get: function () { return splitUrl(reqData.url).hash || undefined }, enumerable: true })

  var headerList = new PropertyList(reqData.headers, syncRequest, true)

  var body = {
    update: function (value) {
      if (value !== null && typeof value === 'object' && (value.mode !== undefined || value.raw !== undefined) && typeof value.raw === 'string') {
        reqData.body = { mode: 'raw', raw: value.raw, language: reqData.body.language || 'text' }
      } else if (typeof value === 'string') {
        reqData.body = { mode: 'raw', raw: value, language: reqData.body.mode === 'raw' && reqData.body.language ? reqData.body.language : 'text' }
      } else {
        reqData.body = { mode: 'raw', raw: stringify(value), language: 'json' }
      }
      syncRequest()
    },
    toString: function () { return reqData.body.mode === 'raw' ? reqData.body.raw || '' : '' },
    isEmpty: function () { return reqData.body.mode === 'none' || (reqData.body.mode === 'raw' && !reqData.body.raw) },
    toJSON: function () { return reqData.body },
  }
  defineProperty(body, 'mode', { get: function () { return reqData.body.mode === 'file' ? 'file' : reqData.body.mode === 'other' ? undefined : reqData.body.mode }, enumerable: true })
  defineProperty(body, 'raw', {
    get: function () { return reqData.body.mode === 'raw' ? reqData.body.raw || '' : undefined },
    set: function (v) { body.update(String(v)) },
    enumerable: true,
  })
  defineProperty(body, 'urlencoded', { get: function () { return new PropertyList((reqData.body.urlencoded || []).slice(), null, false) }, enumerable: true })
  defineProperty(body, 'formdata', { get: function () { return new PropertyList((reqData.body.formdata || []).slice(), null, false) }, enumerable: true })

  var request = {
    addHeader: function (h) { headerList.add(h) },
    removeHeader: function (k) { headerList.remove(k) },
    upsertHeader: function (h) { headerList.upsert(h) },
    getHeaders: function () { return headerList.toObject() },
    toJSON: function () { return { method: reqData.method, url: reqData.url, headers: headerList.all(), body: reqData.body } },
  }
  defineProperty(request, 'url', { get: function () { return url }, set: setUrl, enumerable: true })
  defineProperty(request, 'method', {
    get: function () { return reqData.method },
    set: function (v) { reqData.method = String(v).toUpperCase(); syncRequest() },
    enumerable: true,
  })
  defineProperty(request, 'headers', { get: function () { return headerList }, enumerable: true })
  defineProperty(request, 'body', {
    get: function () { return body },
    set: function (v) { body.update(v) },
    enumerable: true,
  })
  defineProperty(request, 'name', { get: function () { return INIT.info.requestName }, enumerable: true })
  defineProperty(request, 'id', { get: function () { return INIT.info.requestId }, enumerable: true })

  // -------------------------------------------------------------------------
  // pm.response (test scripts)
  // -------------------------------------------------------------------------

  var response
  var RES = INIT.response
  if (RES) {
    if (RES.truncated) consoleObj.warn('The response body is larger than 8 MB; scripts see only the first 8 MB.')
    var resHeaders = new PropertyList(RES.headers.map(function (h) { return { key: h.key, value: h.value } }), null, true)
    var bodyText = RES.body === null ? '' : RES.body
    response = {
      __slingerResponse: true,
      code: RES.code,
      status: RES.status,
      responseTime: RES.responseTime,
      responseSize: RES.size,
      headers: resHeaders,
      text: function () { return bodyText },
      json: function () {
        try {
          return parse(bodyText)
        } catch (e) {
          var err = new Error('JSONError: ' + e.message + ' (the response body is not valid JSON)')
          err.name = 'JSONError'
          throw err
        }
      },
      reason: function () { return RES.status },
      size: function () { return { body: RES.size, header: 0, total: RES.size } },
      toJSON: function () { return { code: RES.code, status: RES.status, headers: resHeaders.all(), responseTime: RES.responseTime, responseSize: RES.size } },
    }
    defineProperty(response, '__slingerResponse', { enumerable: false })
    defineProperty(response, 'to', { get: function () { return new Assertion(response) }, enumerable: false })
    defineProperty(response, 'body', { get: function () { return bodyText }, enumerable: false })
  }

  function cookieJar() {
    var list = []
    if (RES) {
      RES.headers.forEach(function (h) {
        if (String(h.key).toLowerCase() !== 'set-cookie') return
        var first = String(h.value).split(';')[0]
        var i = first.indexOf('=')
        if (i > 0) list.push({ name: first.slice(0, i).trim(), value: first.slice(i + 1).trim() })
      })
    }
    return {
      get: function (name) { var c = list.filter(function (x) { return x.name === name }); return c.length ? c[c.length - 1].value : undefined },
      has: function (name) { return list.some(function (x) { return x.name === name }) },
      toObject: function () { var o = {}; list.forEach(function (c) { o[c.name] = c.value }); return o },
      all: function () { return list.slice() },
    }
  }

  // -------------------------------------------------------------------------
  // Variable scopes
  // -------------------------------------------------------------------------

  function scopeApi(scope) {
    return {
      get: function (k) { return host('scope.get', [scope, k]) },
      set: function (k, v) { host('scope.set', [scope, k, v === undefined ? null : v]) },
      has: function (k) { return host('scope.has', [scope, k]) },
      unset: function (k) { host('scope.unset', [scope, k]) },
      clear: function () { host('scope.clear', [scope]) },
      toObject: function () { return host('scope.toObject', [scope]) },
      replaceIn: function (t) { return host('replaceIn', [t]) },
    }
  }

  var environment = {
    get: function (k) { return host('env.get', [k]) },
    set: function (k, v) { host('env.set', [k, v === undefined ? null : v]) },
    unset: function (k) { host('env.unset', [k]) },
    has: function (k) { return host('env.has', [k]) },
    clear: function () { host('env.clear') },
    toObject: function () { return host('env.toObject') },
    replaceIn: function (t) { return host('replaceIn', [t]) },
  }
  defineProperty(environment, 'name', { value: INIT.environmentName || undefined, enumerable: true })

  var local = scopeApi('local')
  var variables = {
    get: function (k) { return host('vars.get', [k]) },
    has: function (k) { return host('vars.has', [k]) },
    set: local.set,
    unset: local.unset,
    clear: local.clear,
    toObject: function () { return host('vars.toObject') },
    replaceIn: function (t) { return host('replaceIn', [t]) },
  }

  // -------------------------------------------------------------------------
  // pm.test
  // -------------------------------------------------------------------------

  var pending = []
  function errorText(e) {
    if (e && typeof e === 'object' && e.message !== undefined) return (e.name ? e.name + ': ' : '') + e.message
    return String(e)
  }
  function report(name, status, error) {
    host('test', [name, status, error === undefined || error === null ? null : errorText(error)])
  }
  function test(name, fn) {
    name = String(name)
    if (typeof fn !== 'function') {
      report(name, 'skipped')
      return test
    }
    if (fn.length > 0) {
      var entry = { name: name, done: false }
      pending.push(entry)
      var done = function (err) {
        if (entry.done) return
        entry.done = true
        report(name, err ? 'failed' : 'passed', err || null)
      }
      try {
        fn(done)
      } catch (e) {
        if (!entry.done) {
          entry.done = true
          report(name, 'failed', e)
        }
      }
      return test
    }
    try {
      var r = fn()
      if (r && typeof r.then === 'function') {
        var p = { name: name, done: false }
        pending.push(p)
        r.then(
          function () { if (!p.done) { p.done = true; report(name, 'passed') } },
          function (e) { if (!p.done) { p.done = true; report(name, 'failed', e) } },
        )
      } else report(name, 'passed')
    } catch (e) {
      report(name, 'failed', e)
    }
    return test
  }
  test.skip = function (name) {
    report(String(name), 'skipped')
    return test
  }

  // -------------------------------------------------------------------------
  // pm
  // -------------------------------------------------------------------------

  function unsupported(what, why) {
    return function () {
      throw new Error(what + ' is not supported in Slinger scripts' + (why ? ' (' + why + ')' : '') + '.')
    }
  }

  var pm = {
    info: {
      eventName: EVENT,
      iteration: INIT.info.iteration,
      iterationCount: INIT.info.iterationCount,
      requestName: INIT.info.requestName,
      requestId: INIT.info.requestId,
    },
    environment: environment,
    variables: variables,
    collectionVariables: scopeApi('collection'),
    globals: scopeApi('globals'),
    iterationData: {
      get: function () { return undefined },
      has: function () { return false },
      toObject: function () { return {} },
      replaceIn: function (t) { return host('replaceIn', [t]) },
    },
    request: request,
    test: test,
    expect: expect,
    sendRequest: unsupported('pm.sendRequest', 'scripts cannot make network requests'),
    visualizer: { set: unsupported('pm.visualizer') },
    execution: { setNextRequest: unsupported('pm.execution.setNextRequest'), skipRequest: unsupported('pm.execution.skipRequest') },
  }
  defineProperty(pm, 'cookies', { get: cookieJar, enumerable: true })
  if (response) pm.response = response

  // -------------------------------------------------------------------------
  // Globals: pm, console, legacy postman API, base64 helpers
  // -------------------------------------------------------------------------

  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  function btoa(input) {
    var s = String(input)
    var out = ''
    for (var i = 0; i < s.length; i += 3) {
      var a = s.charCodeAt(i)
      var b = s.charCodeAt(i + 1)
      var c = s.charCodeAt(i + 2)
      if (a > 255 || b > 255 || c > 255) throw new Error('btoa: the string contains characters outside of the Latin1 range')
      var n = (a << 16) | ((b || 0) << 8) | (c || 0)
      out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < s.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < s.length ? B64[n & 63] : '=')
    }
    return out
  }
  function atob(input) {
    var s = String(input).replace(/[\s=]+/g, '')
    if (/[^A-Za-z0-9+/]/.test(s) || s.length % 4 === 1) throw new Error('atob: the string is not valid base64')
    var out = ''
    var bits = 0
    var buf = 0
    for (var i = 0; i < s.length; i++) {
      buf = (buf << 6) | B64.indexOf(s[i])
      bits += 6
      if (bits >= 8) {
        bits -= 8
        out += String.fromCharCode((buf >> bits) & 255)
      }
    }
    return out
  }

  var timerMsg = unsupported('Timers (setTimeout / setInterval)', 'scripts run synchronously; use promises instead')

  G.pm = pm
  G.console = consoleObj
  G.btoa = btoa
  G.atob = atob
  G.setTimeout = timerMsg
  G.setInterval = timerMsg
  G.setImmediate = timerMsg
  G.clearTimeout = function () {}
  G.clearInterval = function () {}
  G.require = function (name) {
    throw new Error("require('" + name + "') is not supported in Slinger scripts: no modules, file system or network are available.")
  }

  // Legacy (pre-pm) Postman sandbox API.
  G.tests = {}
  G.postman = {
    setEnvironmentVariable: environment.set,
    getEnvironmentVariable: environment.get,
    clearEnvironmentVariable: environment.unset,
    clearEnvironmentVariables: environment.clear,
    setGlobalVariable: pm.globals.set,
    getGlobalVariable: pm.globals.get,
    clearGlobalVariable: pm.globals.unset,
    clearGlobalVariables: pm.globals.clear,
    getResponseHeader: function (name) { return response ? response.headers.get(name) : undefined },
    getResponseCookie: function (name) { var v = cookieJar().get(name); return v === undefined ? undefined : { name: name, value: v } },
    setNextRequest: unsupported('postman.setNextRequest'),
  }
  G.iteration = INIT.info.iteration
  defineProperty(G, 'environment', { get: function () { return environment.toObject() }, configurable: true })
  defineProperty(G, 'globals', { get: function () { return pm.globals.toObject() }, configurable: true })
  defineProperty(G, 'request', {
    get: function () {
      return { url: reqData.url, method: reqData.method, headers: headerList.toObject(), data: reqData.body.mode === 'raw' ? reqData.body.raw || '' : {}, name: INIT.info.requestName, id: INIT.info.requestId }
    },
    configurable: true,
  })
  if (response) {
    G.responseBody = bodyText
    G.responseCode = { code: RES.code, name: RES.status, detail: RES.status }
    G.responseHeaders = resHeaders.toObject()
    G.responseTime = RES.responseTime
    G.responseCookies = cookieJar().all()
  }

  // Called by the host after the script (and its promise jobs) finished.
  G.__slinger_finish = function () {
    var t = G.tests
    if (t && typeof t === 'object') {
      keysOf(t).forEach(function (k) { report(k, t[k] ? 'passed' : 'failed', t[k] ? null : 'tests["' + k + '"] was falsy') })
    }
    pending.forEach(function (p) {
      if (!p.done) {
        p.done = true
        report(p.name, 'failed', new Error('the test did not finish (its promise or done() callback never settled)'))
      }
    })
  }
})(globalThis.__slinger_call)
delete globalThis.__slinger_call
