const path = require('path');

module.exports = {
  entry: './webviews/src/stats.js',
  output: {
    path: path.resolve(__dirname, 'out'),
    filename: 'stats.bundle.js',
  },
  optimization: {
    minimize: false
  },
  devtool: 'eval-cheap-source-map'
};