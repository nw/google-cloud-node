/*!
 * Copyright 2016 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/*!
 * @module bigtable/table
 */

'use strict';

var arrify = require('arrify');
var common = require('@google-cloud/common');
var concat = require('concat-stream');
var events = require('events');
var flatten = require('lodash.flatten');
var is = require('is');
var propAssign = require('prop-assign');
var pumpify = require('pumpify');
var through = require('through2');
var util = require('util');

/**
 * @type {module:bigtable/family}
 * @private
 */
var Family = require('./family.js');

/**
 * @type {module:bigtable/filter}
 * @private
 */
var Filter = require('./filter.js');

/**
 * @type {module:bigtable/mutation}
 * @private
 */
var Mutation = require('./mutation.js');

/**
 * @type {module:bigtable/row}
 * @private
 */
var Row = require('./row.js');

/**
 * Create a Table object to interact with a Google Cloud Bigtable table.
 *
 * @constructor
 * @alias module:bigtable/table
 *
 * @param {string} name - Name of the table.
 *
 * @example
 * var instance = bigtable.instance('my-instance');
 * var table = instance.table('prezzy');
 */
function Table(instance, name) {
  var id = Table.formatName_(instance.id, name);

  var methods = {

    /**
     * Create a table.
     *
     * @param {object=} options - See {module:bigtable/instance#createTable}.
     *
     * @example
     * table.create(function(err, table, apiResponse) {
     *   if (!err) {
     *     // The table was created successfully.
     *   }
     * });
     */
    create: true,

    /**
     * Delete the table.
     *
     * @param {function=} callback - The callback function.
     * @param {?error} callback.err - An error returned while making this
     *     request.
     * @param {object} callback.apiResponse - The full API response.
     *
     * @example
     * table.delete(function(err, apiResponse) {});
     */
    delete: {
      protoOpts: {
        service: 'BigtableTableAdmin',
        method: 'deleteTable'
      },
      reqOpts: {
        name: id
      }
    },

    /**
     * Check if a table exists.
     *
     * @param {function} callback - The callback function.
     * @param {?error} callback.err - An error returned while making this
     *     request.
     * @param {boolean} callback.exists - Whether the table exists or not.
     *
     * @example
     * table.exists(function(err, exists) {});
     */
    exists: true,

    /**
     * Get a table if it exists.
     *
     * You may optionally use this to "get or create" an object by providing an
     * object with `autoCreate` set to `true`. Any extra configuration that is
     * normally required for the `create` method must be contained within this
     * object as well.
     *
     * @param {options=} options - Configuration object.
     * @param {boolean} options.autoCreate - Automatically create the object if
     *     it does not exist. Default: `false`
     * @param {string} options.view - The view to be applied to the table
     *   fields. See {module:bigtable/table#getMetadata}.
     *
     * @example
     * table.get(function(err, table, apiResponse) {
     *   // The `table` data has been populated.
     * });
     */
    get: true
  };

  var config = {
    parent: instance,
    id: id,
    methods: methods,
    createMethod: function(_, options, callback) {
      instance.createTable(name, options, callback);
    }
  };

  common.GrpcServiceObject.call(this, config);
}

util.inherits(Table, common.GrpcServiceObject);

/**
 * The view to be applied to the returned table's fields.
 * Defaults to schema if unspecified.
 *
 * @private
 */
Table.VIEWS = {
  unspecified: 0,
  name: 1,
  schema: 2,
  full: 4
};

/**
 * Formats the table name to include the Bigtable cluster.
 *
 * @private
 *
 * @param {string} instanceName - The formatted instance name.
 * @param {string} name - The table name.
 *
 * @example
 * Table.formatName_(
 *   'projects/my-project/zones/my-zone/instances/my-instance',
 *   'my-table'
 * );
 * // 'projects/my-project/zones/my-zone/instances/my-instance/tables/my-table'
 */
Table.formatName_ = function(instanceName, name) {
  if (name.indexOf('/') > -1) {
    return name;
  }

  return instanceName + '/tables/' + name;
};

/**
 * Create a column family.
 *
 * Optionally you can send garbage collection rules and when creating a family.
 * Garbage collection executes opportunistically in the background, so it's
 * possible for reads to return a cell even if it matches the active expression
 * for its family.
 *
 * @resource [Garbage Collection Proto Docs]{@link https://github.com/googleapis/googleapis/blob/master/google/bigtable/admin/table/v1/bigtable_table_data.proto#L59}
 *
 * @throws {error} If a name is not provided.
 *
 * @param {string} name - The name of column family.
 * @param {object=} rule - Garbage collection rule.
 * @param {object} rule.age - Delete cells in a column older than the given
 *     age. Values must be at least 1 millisecond.
 * @param {number} rule.versions - Maximum number of versions to delete cells
 *     in a column, except for the most recent.
 * @param {boolean} rule.intersect - Cells to delete should match all rules.
 * @param {boolean} rule.union - Cells to delete should match any of the rules.
 * @param {function} callback - The callback function.
 * @param {?error} callback.err - An error returned while making this request.
 * @param {module:bigtable/family} callback.family - The newly created Family.
 * @param {object} callback.apiResponse - The full API response.
 *
 * @example
 * var callback = function(err, family, apiResponse) {
 *   // `family` is a Family object
 * };
 *
 * var rule = {
 *   age: {
 *     seconds: 0,
 *     nanos: 5000
 *   },
 *   versions: 3,
 *   union: true
 * };
 *
 * table.createFamily('follows', rule, callback);
 */
Table.prototype.createFamily = function(name, rule, callback) {
  var self = this;

  if (is.function(rule)) {
    callback = rule;
    rule = null;
  }

  if (!name) {
    throw new Error('A name is required to create a family.');
  }

  var grpcOpts = {
    service: 'BigtableTableAdmin',
    method: 'modifyColumnFamilies'
  };

  var mod = {
    id: name,
    create: {}
  };

  if (rule) {
    mod.create.gcRule = Family.formatRule_(rule);
  }

  var reqOpts = {
    name: this.id,
    modifications: [mod]
  };

  this.request(grpcOpts, reqOpts, function(err, resp) {
    if (err) {
      callback(err, null, resp);
      return;
    }

    var family = self.family(resp.name);
    family.metadata = resp;
    callback(null, family, resp);
  });
};

/**
 * Delete all rows in the table, optionally corresponding to a particular
 * prefix.
 *
 * @param {options=} options - Configuration object.
 * @param {string} options.prefix - Row key prefix, when omitted all rows
 *     will be deleted.
 * @param {function} callback - The callback function.
 * @param {?error} callback.err - An error returned while making this request.
 * @param {object} callback.apiResponse - The full API response.
 *
 * @example
 * //-
 * // You can supply a prefix to delete all corresponding rows.
 * //-
 * var callback = function(err, apiResponse) {
 *   if (!err) {
 *     // Rows successfully deleted.
 *   }
 * };
 *
 * table.deleteRows({
 *   prefix: 'alincoln'
 * }, callback);
 *
 * //-
 * // If you choose to omit the prefix, all rows in the table will be deleted.
 * //-
 * table.deleteRows(callback);
 */
Table.prototype.deleteRows = function(options, callback) {
  if (is.function(options)) {
    callback = options;
    options = {};
  }

  var grpcOpts = {
    service: 'BigtableTableAdmin',
    method: 'dropRowRange'
  };

  var reqOpts = {
    name: this.id
  };

  if (options.prefix) {
    reqOpts.rowKeyPrefix = Mutation.convertToBytes(options.prefix);
  } else {
    reqOpts.deleteAllDataFromTable = true;
  }

  this.request(grpcOpts, reqOpts, callback);
};

/**
 * Get a reference to a Table Family.
 *
 * @throws {error} If a name is not provided.
 *
 * @param {string} name - The family name.
 * @return {module:bigtable/family}
 *
 * @example
 * var family = table.family('my-family');
 */
Table.prototype.family = function(name) {
  if (!name) {
    throw new Error('A family name must be provided.');
  }

  return new Family(this, name);
};

/**
 * Get Family objects for all the column familes in your table.
 *
 * @param {function} callback - The callback function.
 * @param {?error} callback.err - An error returned while making this request.
 * @param {module:bigtable/family[]} callback.families - The list of families.
 * @param {object} callback.apiResponse - The full API response.
 *
 * @example
 * table.getFamilies(function(err, families, apiResponse) {
 *   // `families` is an array of Family objects.
 * });
 */
Table.prototype.getFamilies = function(callback) {
  var self = this;

  this.getMetadata(function(err, resp) {
    if (err) {
      callback(err, null, resp);
      return;
    }

    var families = Object.keys(resp.columnFamilies).map(function(familyId) {
      var family = self.family(familyId);
      family.metadata = resp.columnFamilies[familyId];
      return family;
    });

    callback(null, families, resp);
  });
};

/**
 * Get the table's metadata.
 *
 * @param {object=} options - Table request options.
 * @param {string} options.view - The view to be applied to the table fields.
 * @param {function=} callback - The callback function.
 * @param {?error} callback.err - An error returned while making this
 *     request.
 * @param {object} callback.metadata - The table's metadata.
 * @param {object} callback.apiResponse - The full API response.
 *
 * @example
 * table.getMetadata(function(err, metadata, apiResponse) {});
 */
Table.prototype.getMetadata = function(options, callback) {
  var self = this;

  if (is.function(options)) {
    callback = options;
    options = {};
  }

  var protoOpts = {
    service: 'BigtableTableAdmin',
    method: 'getTable'
  };

  var reqOpts = {
    name: this.id,
    view: Table.VIEWS[options.view || 'unspecified']
  };

  this.request(protoOpts, reqOpts, function(err, resp) {
    if (err) {
      callback(err, null, resp);
      return;
    }

    self.metadata = resp;
    callback(null, self.metadata, resp);
  });
};

/**
 * Get Row objects for the rows currently in your table.
 *
 * @param {options=} options - Configuration object.
 * @param {boolean} options.decode - If set to `false` it will not decode Buffer
 *     values returned from Bigtable. Default: true.
 * @param {string[]} options.keys - A list of row keys.
 * @param {string} options.start - Start value for key range.
 * @param {string} options.end - End value for key range.
 * @param {object[]} options.ranges - A list of key ranges.
 * @param {module:bigtable/filter} options.filter - Row filters allow you to
 *     both make advanced queries and format how the data is returned.
 * @param {boolean} options.interleave - Allow for interleaving.
 * @param {number} options.limit - Maximum number of rows to be returned.
 * @param {function=} callback - The callback function.
 * @param {?error} callback.err - An error returned while making this request.
 * @param {module:bigtable/row[]} callback.rows - List of Row objects.
 *
 * @example
 * //-
 * // While this method does accept a callback, this is not recommended for
 * // large datasets as it will buffer all rows before executing the callback.
 * // Instead we recommend using the streaming API by simply omitting the
 * // callback.
 * //-
 * var callback = function(err, rows) {
 *   if (!err) {
 *     // `rows` is an array of Row objects.
 *   }
 * };
 *
 * table.getRows(callback);
 *
 * //-
 * // Specify arbitrary keys for a non-contiguous set of rows.
 * // The total size of the keys must remain under 1MB, after encoding.
 * //-
 * table.getRows({
 *   keys: [
 *     'alincoln',
 *     'gwashington'
 *   ]
 * }, callback);
 *
 * //-
 * // Specify a contiguous range of rows to read by supplying `start` and `end`
 * // keys.
 * //
 * // If the `start` key is omitted, it is interpreted as an empty string.
 * // If the `end` key is omitted, it is interpreted as infinity.
 * //-
 * table.getRows({
 *   start: 'alincoln',
 *   end: 'gwashington'
 * }, callback);
 *
 * //-
 * // Specify multiple ranges.
 * //-
 * table.getRows({
 *   ranges: [{
 *     start: 'alincoln',
 *     end: 'gwashington'
 *   }, {
 *     start: 'tjefferson',
 *     end: 'jadams'
 *   }]
 * }, callback);
 *
 * //-
 * // By default, rows are read sequentially, producing results which are
 * // guaranteed to arrive in increasing row order. Setting `interleave` to
 * // true allows multiple rows to be interleaved in the response, which
 * // increases throughput but breaks this guarantee and may force the client
 * // to use more memory to buffer partially-received rows.
 * //-
 * table.getRows({
 *   interleave: true
 * }, callback);
 *
 * //-
 * // Apply a {module:bigtable/filter} to the contents of the specified rows.
 * //-
 * table.getRows({
 *   filter: [
 *     {
 *       column: 'gwashington'
 *     }, {
 *       value: 1
 *     }
 *   ]
 * }, callback);
 *
 * //-
 * // Get the rows from your table as a readable object stream.
 * //-
 * table.getRows()
 *   .on('error', console.error)
 *   .on('data', function(row) {
 *     // `row` is a Row object.
 *   })
 *   .on('end', function() {
 *     // All rows retrieved.
 *   });
 *
 * //-
 * // If you anticipate many results, you can end a stream early to prevent
 * // unnecessary processing.
 * //-
 * table.getRows()
 *   .on('data', function(row) {
 *     this.end();
 *   });
 */
Table.prototype.getRows = function(options, callback) {
  var self = this;

  if (is.function(options)) {
    callback = options;
    options = {};
  }

  options = options || {};
  options.ranges = options.ranges || [];

  var grpcOpts = {
    service: 'Bigtable',
    method: 'readRows'
  };

  var reqOpts = {
    tableName: this.id,
    objectMode: true
  };

  if (options.start || options.end) {
    options.ranges.push({
      start: options.start,
      end: options.end
    });
  }

  if (options.keys || options.ranges.length) {
    reqOpts.rows = {};

    if (options.keys) {
      reqOpts.rows.rowKeys = options.keys.map(Mutation.convertToBytes);
    }

    if (options.ranges.length) {
      reqOpts.rows.rowRanges = options.ranges.map(function(range) {
        return Filter.createRange(range.start, range.end, 'Key');
      });
    }
  }

  if (options.filter) {
    reqOpts.filter = Filter.parse(options.filter);
  }

  if (options.limit) {
    reqOpts.numRowsLimit = options.limit;
  }

  var stream = pumpify.obj([
    this.requestStream(grpcOpts, reqOpts),
    through.obj(function(data, enc, next) {
      var throughStream = this;
      var rows = Row.formatChunks_(data.chunks, {
        decode: options.decode
      });

      rows.forEach(function(rowData) {
        var row = self.row(rowData.key);

        row.data = rowData.data;
        throughStream.push(row);
      });

      next();
    })
  ]);

  if (!is.function(callback)) {
    return stream;
  }

  stream
    .on('error', callback)
    .pipe(concat(function(rows) {
      callback(null, rows);
    }));
};

/**
 * Insert or update rows in your table.
 *
 * @param {object|object[]} entries - List of entries to be inserted.
 *     See {module:bigtable/table#mutate}.
 * @param {function} callback - The callback function.
 * @param {?error} callback.err - An error returned while making this request.
 * @param {object[]} callback.insertErrors - A status object for each failed
 *     insert.
 *
 * @example
 * var callback = function(err, insertErrors) {
 *   if (err) {
 *     // Error handling omitted.
 *   }
 *
 *   // insertErrors = [
 *   //   {
 *   //     code: 500,
 *   //     message: 'Internal Server Error',
 *   //     entry: {
 *   //       key: 'gwashington',
 *   //       data: {
 *   //         follows: {
 *   //           jadams: 1
 *   //         }
 *   //       }
 *   //     }
 *   //   },
 *   //   ...
 *   // ]
 * };
 *
 * var entries = [
 *  {
 *     key: 'alincoln',
 *     data: {
 *       follows: {
 *         gwashington: 1
 *       }
 *     }
 *   }
 * ];
 *
 * table.insert(entries, callback);
 *
 * //-
 * // By default whenever you insert new data, the server will capture a
 * // timestamp of when your data was inserted. It's possible to provide a
 * // date object to be used instead.
 * //-
 * var entries = [
 *   {
 *     key: 'gwashington',
 *     data: {
 *       follows: {
 *         jadams: {
 *           value: 1,
 *           timestamp: new Date('March 22, 2016')
 *         }
 *       }
 *     }
 *   }
 * ];
 *
 * table.insert(entries, callback);
 *
 * //-
 * // If you don't provide a callback, an EventEmitter is returned. Listen for
 * // the error event to catch API and insert errors, and complete for when
 * // the API request has completed.
 * //-
 * table.insert(entries)
 *   .on('error', console.error)
 *   .on('complete', function() {
 *     // All requested inserts have been processed.
 *   });
 */
Table.prototype.insert = function(entries, callback) {
  entries = arrify(entries).map(propAssign('method', Mutation.methods.INSERT));

  return this.mutate(entries, callback);
};

/**
 * Apply a set of changes to be atomically applied to the specified row(s).
 * Mutations are applied in order, meaning that earlier mutations can be masked
 * by later ones.
 *
 * @param {object|object[]} entries - List of entities to be inserted or
 *     deleted.
 * @param {function} callback - The callback function.
 * @param {?error} callback.err - An error returned while making this request.
 * @param {object[]} callback.mutationErrors - A status object for each failed
 *     mutation.
 *
 * @example
 * //-
 * // Insert entities. See {module:bigtable/table#insert}
 * //-
 * var callback = function(err, mutationErrors) {
 *   if (err) {
 *     // Error handling omitted.
 *   }
 *
 *   // mutationErrors = [
 *   //   {
 *   //     code: 500,
 *   //     message: 'Internal Server Error',
 *   //     entry: {
 *   //       method: 'insert',
 *   //       key: 'gwashington',
 *   //       data: {
 *   //         follows: {
 *   //           jadams: 1
 *   //         }
 *   //       }
 *   //     }
 *   //   },
 *   //   ...
 *   // ]
 * };
 *
 * var entries = [
 *   {
 *     method: 'insert',
 *     key: 'gwashington',
 *     data: {
 *       follows: {
 *         jadams: 1
 *       }
 *     }
 *   }
 * ];
 *
 * table.mutate(entries, callback)
 *
 * //-
 * // Delete entities. See {module:bigtable/row#deleteCells}
 * //-
 * var entries = [
 *   {
 *     method: 'delete',
 *     key: 'gwashington'
 *   }
 * ];
 *
 * table.mutate(entries, callback);
 *
 * //-
 * // Delete specific columns within a row.
 * //-
 * var entries = [
 *   {
 *     method: 'delete',
 *     key: 'gwashington',
 *     data: [
 *       'follows:jadams'
 *     ]
 *   }
 * ];
 *
 * table.mutate(entries, callback);
 *
 * //-
 * // Mix and match mutations. This must contain at least one entry and at
 * // most 100,000.
 * //-
 * var entries = [
 *   {
 *     method: 'insert',
 *     key: 'alincoln',
 *     data: {
 *       follows: {
 *         gwashington: 1
 *       }
 *     }
 *   }, {
 *     method: 'delete',
 *     key: 'jadams',
 *     data: [
 *       'follows:gwashington'
 *     ]
 *   }
 * ];
 *
 * table.mutate(entries, callback);
 *
 * //-
 * // If you don't provide a callback, an EventEmitter is returned. Listen for
 * // the error event to catch API and mutation errors, and complete for when
 * // the API request has completed.
 * //-
 * table.mutate(entries)
 *   .on('error', console.error)
 *   .on('complete', function() {
 *     // All requested mutations have been processed.
 *   });
 */
Table.prototype.mutate = function(entries, callback) {
  entries = flatten(arrify(entries));

  var grpcOpts = {
    service: 'Bigtable',
    method: 'mutateRows'
  };

  var reqOpts = {
    objectMode: true,
    tableName: this.id,
    entries: entries.map(Mutation.parse)
  };

  var isCallbackMode = is.function(callback);
  var emitter = null;

  if (!isCallbackMode) {
    emitter = new events.EventEmitter();
  }

  var stream = pumpify.obj([
    this.requestStream(grpcOpts, reqOpts),
    through.obj(function(data, enc, next) {
      var throughStream = this;

      data.entries.forEach(function(entry) {
        // mutation was successful, no need to notify the user
        if (entry.status.code === 0) {
          return;
        }

        var status = common.GrpcService.decorateStatus_(entry.status);
        status.entry = entries[entry.index];


        if (!isCallbackMode) {
          emitter.emit('error', status);
          return;
        }

        throughStream.push(status);
      });

      next();
    })
  ]);

  if (!isCallbackMode) {
    stream.on('error', emitter.emit.bind(emitter, 'error'));
    stream.on('finish', emitter.emit.bind(emitter, 'complete'));
    return emitter;
  }

  stream
    .on('error', callback)
    .pipe(concat(function(mutationErrors) {
      callback(null, mutationErrors);
    }));
};

/**
 * Get a reference to a table row.
 *
 * @throws {error} If a key is not provided.
 *
 * @param {string} key - The row key.
 * @return {module:bigtable/row}
 *
 * @example
 * var row = table.row('lincoln');
 */
Table.prototype.row = function(key) {
  if (!key) {
    throw new Error('A row key must be provided.');
  }

  return new Row(this, key);
};

/**
 * Returns a sample of row keys in the table. The returned row keys will delimit
 * contigous sections of the table of approximately equal size, which can be
 * used to break up the data for distributed tasks like mapreduces.
 *
 * @param {function=} callback - The callback function.
 * @param {?error} callback.err - An error returned while making this request.
 * @param {object[]} callback.keys - The list of keys.
 *
 * @example
 * table.sampleRowKeys(function(err, keys) {
 *   // keys = [
 *   //   {
 *   //     key: '',
 *   //     offset: '805306368'
 *   //   },
 *   //   ...
 *   // ]
 * });
 *
 * //-
 * // Get the keys from your table as a readable object stream.
 * //-
 * table.sampleRowKeys()
 *   .on('error', console.error)
 *   .on('data', function(key) {
 *     // Do something with the `key` object.
 *   });
 *
 * //-
 * // If you anticipate many results, you can end a stream early to prevent
 * // unnecessary processing.
 * //-
 * table.sampleRowKeys()
 *   .on('data', function(key) {
 *     this.end();
 *   });
 */
Table.prototype.sampleRowKeys = function(callback) {
  var grpcOpts = {
    service: 'Bigtable',
    method: 'sampleRowKeys'
  };

  var reqOpts = {
    tableName: this.id,
    objectMode: true
  };

  var stream = pumpify.obj([
    this.requestStream(grpcOpts, reqOpts),
    through.obj(function(key, enc, next) {
      next(null, {
        key: key.rowKey,
        offset: key.offsetBytes
      });
    })
  ]);

  if (!is.function(callback)) {
    return stream;
  }

  stream
    .on('error', callback)
    .pipe(concat(function(keys) {
      callback(null, keys);
    }));
};

module.exports = Table;
